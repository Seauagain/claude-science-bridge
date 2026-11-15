import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { ScienceCli } from "../science-cli.ts";
import { isRecord, type JsonRecord } from "../validate.ts";
import { readFurtherMessage } from "./further-message.ts";

/** A turn in progress on the fake daemon, handed to a {@link ReplyScript}. */
export interface FakeTurn {
  /** Identifier of the conversation the turn belongs to. */
  readonly conversationId: string;
  /** The user message that started the turn. */
  readonly message: string;
  /** Streams one piece of reply text. */
  replyText(chunk: string): void;
  /** Ends the turn successfully. */
  complete(): void;
  /** Ends the turn as failed, with the reason the daemon would report. */
  fail(description: string): void;
  /**
   * Resolves when the turn is cancelled through `POST /frames/<id>/cancel`. A script that awaits
   * it keeps the reply running until then.
   */
  readonly cancelled: Promise<void>;
}

/** Decides how the fake daemon answers one message. */
export type ReplyScript = (turn: FakeTurn) => void | Promise<void>;

/** What the fake daemon recorded about one conversation. */
export interface FakeConversation {
  readonly projectId: string;
  /** User messages, in the order they were sent. */
  readonly messages: readonly string[];
  /** The conversation frame's current status. */
  readonly status: string;
}

/** A stand-in for the Claude Science daemon that implements docs/protocol.md. */
export interface FakeScienceDaemon {
  /** A Science CLI stand-in that answers `status` and `url` for this fake daemon. */
  readonly scienceCli: ScienceCli;
  /** Makes the Science CLI stand-in report the daemon as running (the default) or not running. */
  reportRunning(running: boolean): void;
  /** Makes the Science CLI stand-in report `version` instead of the version protocol.md covers. */
  reportVersion(version: string): void;
  /**
   * Answers the next logged-in request to `route` (for example `"GET /api/me"`) with `body`
   * instead of the usual response, as a daemon version with a different interface would.
   */
  respondOnce(route: string, body: unknown): void;
  /** Creates a project, archived if asked, and returns its identifier. */
  addProject(name: string, options?: { readonly archived?: boolean }): string;
  /** Queues the script for the next message. Unscripted messages get the reply "pong". */
  onNextMessage(script: ReplyScript): void;
  /** Every conversation started so far, oldest first. */
  conversations(): FakeConversation[];
  /**
   * Identifiers of the conversations a cancel was requested for, oldest request first. Includes
   * requests that found no running turn.
   */
  cancelRequests(): string[];
  /** Pushes an event to every open socket, as the daemon does for the user's other activity. */
  broadcast(event: JsonRecord): void;
  /** How many event sockets are open right now. */
  eventConnectionCount(): number;
  close(): Promise<void>;
}

interface Project {
  readonly name: string;
  /** When the project was archived, or null for a project in use. */
  readonly archivedAt: string | null;
}

interface Conversation {
  readonly id: string;
  readonly projectId: string;
  readonly agentName: string;
  readonly messages: string[];
  status: string;
  /** Sent along with `status`; the reason when a turn failed. */
  statusDescription: string | undefined;
  /** Cancels the turn in progress. Undefined while no turn is running. */
  cancelTurn: (() => void) | undefined;
}

/** The daemon version docs/protocol.md was observed on. */
const OBSERVED_VERSION = "0.1.53";
const AGENT_NAME = "OPERON";
const TIMESTAMP = "2026-11-15T08:00:00Z";
const defaultReply: ReplyScript = (turn) => {
  turn.replyText("pong");
  turn.complete();
};

export async function startFakeScienceDaemon(): Promise<FakeScienceDaemon> {
  const daemon = new FakeDaemon();
  await daemon.listen();
  return daemon;
}

class FakeDaemon implements FakeScienceDaemon {
  readonly #server: Server;
  readonly #sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => [...offered][0] ?? false,
  });
  readonly #nonces = new Set<string>();
  readonly #logins = new Set<string>();
  readonly #projects = new Map<string, Project>();
  readonly #conversations: Conversation[] = [];
  readonly #scripts: ReplyScript[] = [];
  readonly #intentIds = new Set<string>();
  readonly #cancelRequests: string[] = [];
  readonly #responseOverrides = new Map<string, unknown>();
  #port = 0;
  #running = true;
  #version = OBSERVED_VERSION;

  constructor() {
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        sendJson(response, 500, { detail: `fake daemon bug: ${String(error)}` });
      });
    });
    this.#server.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  readonly scienceCli: ScienceCli = async (args) => {
    if (args[0] === "status") {
      // What the real program prints besides `running` when no daemon is up is not known.
      if (!this.#running) return JSON.stringify({ running: false });
      return JSON.stringify({ running: true, version: this.#version, port: this.#port });
    }
    if (args[0] === "url") {
      const nonce = randomBytes(16).toString("hex");
      this.#nonces.add(nonce);
      return `http://localhost:${this.#port}/?nonce=${nonce}\n`;
    }
    throw new Error(`fake Science CLI: unsupported arguments ${args.join(" ")}`);
  };

  reportRunning(running: boolean): void {
    this.#running = running;
  }

  reportVersion(version: string): void {
    this.#version = version;
  }

  respondOnce(route: string, body: unknown): void {
    this.#responseOverrides.set(route, body);
  }

  addProject(name: string, options: { readonly archived?: boolean } = {}): string {
    const projectId = `proj_${randomBytes(6).toString("hex")}`;
    this.#projects.set(projectId, { name, archivedAt: options.archived ? TIMESTAMP : null });
    return projectId;
  }

  onNextMessage(script: ReplyScript): void {
    this.#scripts.push(script);
  }

  conversations(): FakeConversation[] {
    return this.#conversations.map(({ projectId, messages, status }) => ({
      projectId,
      messages: [...messages],
      status,
    }));
  }

  cancelRequests(): string[] {
    return [...this.#cancelRequests];
  }

  broadcast(event: JsonRecord): void {
    const text = JSON.stringify(event);
    for (const socket of this.#sockets.clients) socket.send(text);
  }

  eventConnectionCount(): number {
    return this.#sockets.clients.size;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets.clients) socket.terminate();
    this.#sockets.close();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  get #origin(): string {
    return `http://localhost:${this.#port}`;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.#origin);
    const route = `${request.method} ${url.pathname}`;
    const cookies = parseCookies(request);

    if (route === "GET /health") return sendJson(response, 200, { status: "ok" });
    if (route === "GET /") {
      response.setHeader("set-cookie", `operon_csrf=${randomBytes(16).toString("hex")}; Path=/`);
      response.writeHead(200, { "content-type": "text/html" }).end("<form></form>");
      return;
    }
    if (route === "POST /api/auth/nonce") {
      const nonce = new URLSearchParams(await readBody(request)).get("nonce") ?? "";
      if (!this.#nonces.delete(nonce)) {
        return sendJson(response, 401, { detail: "Invalid or expired nonce" });
      }
      const login = randomBytes(16).toString("hex");
      this.#logins.add(login);
      response.setHeader("set-cookie", `operon_auth=${login}; Path=/; HttpOnly`);
      return sendJson(response, 200, { ok: true });
    }

    if (!this.#isLoggedIn(cookies)) return sendJson(response, 401, { detail: "Not authenticated" });
    if (request.method === "POST" && !this.#hasValidCsrf(request, cookies)) {
      return sendJson(response, 403, { detail: "CSRF check failed", code: "csrf_invalid" });
    }

    if (this.#responseOverrides.has(route)) {
      const body = this.#responseOverrides.get(route);
      this.#responseOverrides.delete(route);
      return sendJson(response, 200, body);
    }

    if (route === "GET /api/me") return sendJson(response, 200, { user_id: "fake-user" });
    if (route === "GET /api/projects") return this.#listProjects(response);
    const startMatch = /^\/api\/projects\/([^/]+)\/request$/.exec(url.pathname);
    if (request.method === "POST" && startMatch) {
      return this.#startConversation(decodeURIComponent(startMatch[1] ?? ""), request, response);
    }
    const frameMatch = /^\/api\/frames\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && frameMatch) {
      return this.#sendFrame(decodeURIComponent(frameMatch[1] ?? ""), response);
    }
    if (route === "POST /api/request") return this.#sendMessage(request, response);
    const cancelMatch = /^\/api\/frames\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === "POST" && cancelMatch) {
      return this.#cancel(decodeURIComponent(cancelMatch[1] ?? ""), response);
    }
    sendJson(response, 404, { detail: `Not found: ${route}` });
  }

  #sendFrame(frameId: string, response: ServerResponse): void {
    const conversation = this.#conversations.find((candidate) => candidate.id === frameId);
    if (conversation === undefined) {
      sendJson(response, 404, { detail: `Frame ${frameId} not found` });
      return;
    }
    sendJson(response, 200, {
      id: conversation.id,
      root_frame_id: conversation.id,
      parent_frame_id: null,
      project_id: conversation.projectId,
      agent_name: conversation.agentName,
      status: conversation.status,
      conversation_type: "agent",
    });
  }

  /** `POST /request`: a further message to an existing conversation. */
  async #sendMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const message = readFurtherMessage(
      JSON.parse(await readBody(request)),
      this.#conversations,
      this.#intentIds,
    );
    if ("refusal" in message) {
      return sendJson(response, message.refusal.httpStatus, { detail: message.refusal.detail });
    }
    this.#intentIds.add(message.intentId);
    this.#beginTurn(message.conversation, message.text);
    sendJson(response, 200, {
      root_frame_id: message.conversation.id,
      frame_id: message.conversation.id,
      status: message.responseStatus,
    });
  }

  /**
   * `POST /frames/<root_id>/cancel`: the running turn ends with status `cancelled`.
   *
   * docs/protocol.md does not say what the daemon answers for a conversation it does not know or
   * one with no running turn. The fake answers 404 and an empty `cancelled_frames` respectively,
   * and changes nothing.
   */
  #cancel(conversationId: string, response: ServerResponse): void {
    this.#cancelRequests.push(conversationId);
    const conversation = this.#conversations.find(({ id }) => id === conversationId);
    if (conversation === undefined) {
      sendJson(response, 404, { detail: `Frame ${conversationId} not found` });
      return;
    }
    const running = conversation.cancelTurn !== undefined;
    conversation.cancelTurn?.();
    sendJson(response, 200, {
      root_frame_id: conversation.id,
      cancelled_frames: running ? [conversation.id] : [],
    });
  }

  #listProjects(response: ServerResponse): void {
    const projects = [...this.#projects].map(([projectId, project]) => ({
      project_id: projectId,
      name: project.name,
      description: "",
      conversation_count: this.#conversations.filter((each) => each.projectId === projectId).length,
      archived_at: project.archivedAt,
      updated_at: TIMESTAMP,
    }));
    sendJson(response, 200, { projects, total: projects.length });
  }

  async #startConversation(
    projectId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.#projects.has(projectId)) {
      return sendJson(response, 404, { detail: `Project ${projectId} not found` });
    }
    const body: unknown = JSON.parse(await readBody(request));
    const input = isRecord(body) && isRecord(body.input_data) ? body.input_data.request : undefined;
    if (typeof input !== "string") {
      return sendJson(response, 400, {
        detail: "Invalid arguments: body.input_data.request: Required",
      });
    }

    const conversation: Conversation = {
      id: randomUUID(),
      projectId,
      agentName: AGENT_NAME,
      messages: [],
      status: "processing",
      statusDescription: undefined,
      cancelTurn: undefined,
    };
    this.#conversations.push(conversation);
    this.#beginTurn(conversation, input);
    sendJson(response, 200, {
      root_frame_id: conversation.id,
      frame_id: conversation.id,
      status: "accepted",
    });
  }

  /** Emits the events of "Turn lifecycle" in docs/protocol.md, then runs the reply script. */
  #beginTurn(conversation: Conversation, message: string): void {
    // The daemon re-sends the previous turn's final status just before the next turn starts.
    if (conversation.messages.length > 0) this.#emitStatus(conversation);
    conversation.messages.push(message);
    this.#setStatus(conversation, "processing");
    this.#emit(conversation, { type: "frame_activity", phase: "llm_call", iteration: 1 });

    let finished = false;
    let announceCancelled = () => {};
    const cancelled = new Promise<void>((resolve) => {
      announceCancelled = resolve;
    });
    const finish = (status: string, description?: string) => {
      if (finished) return;
      finished = true;
      conversation.cancelTurn = undefined;
      this.#emit(conversation, { type: "frame_messages_delta", base_idx: 0, appended: null });
      this.#setStatus(conversation, status, description);
    };
    const turn: FakeTurn = {
      conversationId: conversation.id,
      message,
      replyText: (chunk) => {
        if (!finished) this.#emit(conversation, { type: "text_chunk", block_type: "text", chunk });
      },
      complete: () => finish("completed"),
      fail: (description) => finish("failed", description),
      cancelled,
    };
    conversation.cancelTurn = () => {
      finish("cancelled");
      announceCancelled();
    };

    const script = this.#scripts.shift() ?? defaultReply;
    setImmediate(() => {
      Promise.resolve()
        .then(() => script(turn))
        .catch((error: unknown) => turn.fail(`reply script threw: ${String(error)}`));
    });
  }

  #setStatus(conversation: Conversation, status: string, description?: string): void {
    conversation.status = status;
    conversation.statusDescription = description;
    this.#emitStatus(conversation);
  }

  #emitStatus(conversation: Conversation): void {
    const description = conversation.statusDescription;
    this.#emit(conversation, {
      type: "frame_update",
      status: conversation.status,
      agent_name: conversation.agentName,
      project_id: conversation.projectId,
      conversation_type: "agent",
      has_pending_input: false,
      pending_input_requests: [],
      ...(description === undefined ? {} : { status_description: description }),
    });
  }

  #emit(conversation: Conversation, event: JsonRecord): void {
    this.broadcast({ ...event, root_frame_id: conversation.id, frame_id: conversation.id });
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const cookies = parseCookies(request);
    const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",");
    const expected = `operon-csrf.${cookies.get("operon_csrf")}`;
    const accepted =
      (request.url ?? "").startsWith("/api/ws") &&
      this.#isLoggedIn(cookies) &&
      offered.some((protocol) => protocol.trim() === expected) &&
      request.headers.origin === this.#origin;
    if (!accepted) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    this.#sockets.handleUpgrade(request, socket, head, (client) => this.#serve(client));
  }

  #serve(client: WebSocket): void {
    client.on("message", (data) => {
      const message: unknown = JSON.parse(String(data));
      if (isRecord(message) && message.type === "ping") client.send('{"type":"pong"}');
    });
    // The real daemon pushes events nobody asked for; clients must ignore them.
    client.send(JSON.stringify({ type: "environment_status", environments: [] }));
  }

  #isLoggedIn(cookies: Map<string, string>): boolean {
    return this.#logins.has(cookies.get("operon_auth") ?? "");
  }

  #hasValidCsrf(request: IncomingMessage, cookies: Map<string, string>): boolean {
    const token = cookies.get("operon_csrf");
    return (
      token !== undefined &&
      request.headers["x-operon-csrf"] === token &&
      request.headers.origin === this.#origin
    );
  }
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0)
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return cookies;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
