import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { ScienceCli } from "../science-cli.ts";
import { isRecord, type JsonRecord } from "../validate.ts";

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
  /**
   * Answers the next logged-in request to `route` (for example `"GET /api/me"`) with `body`
   * instead of the usual response, as a daemon version with a different interface would.
   */
  respondOnce(route: string, body: unknown): void;
  /** Creates a project and returns its identifier. */
  addProject(name: string): string;
  /** Queues the script for the next message. Unscripted messages get the reply "pong". */
  onNextMessage(script: ReplyScript): void;
  /** Every conversation started so far, oldest first. */
  conversations(): FakeConversation[];
  /** Pushes an event to every open socket, as the daemon does for the user's other activity. */
  broadcast(event: JsonRecord): void;
  close(): Promise<void>;
}

interface Conversation {
  readonly id: string;
  readonly projectId: string;
  readonly messages: string[];
  status: string;
}

const VERSION = "0.1.53";
const AGENT_NAME = "OPERON";
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
  readonly #projects = new Map<string, string>();
  readonly #conversations: Conversation[] = [];
  readonly #scripts: ReplyScript[] = [];
  readonly #responseOverrides = new Map<string, unknown>();
  #port = 0;
  #running = true;

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
      return JSON.stringify({ running: true, version: VERSION, port: this.#port });
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

  respondOnce(route: string, body: unknown): void {
    this.#responseOverrides.set(route, body);
  }

  addProject(name: string): string {
    const projectId = `proj_${randomBytes(6).toString("hex")}`;
    this.#projects.set(projectId, name);
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

  broadcast(event: JsonRecord): void {
    const text = JSON.stringify(event);
    for (const socket of this.#sockets.clients) socket.send(text);
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
    const startMatch = /^\/api\/projects\/([^/]+)\/request$/.exec(url.pathname);
    if (request.method === "POST" && startMatch) {
      return this.#startConversation(decodeURIComponent(startMatch[1] ?? ""), request, response);
    }
    sendJson(response, 404, { detail: `Not found: ${route}` });
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
      messages: [],
      status: "processing",
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
    conversation.messages.push(message);
    this.#setStatus(conversation, "processing");
    this.#emit(conversation, { type: "frame_activity", phase: "llm_call", iteration: 1 });

    let finished = false;
    const finish = (status: string, description?: string) => {
      if (finished) return;
      finished = true;
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
    this.#emit(conversation, {
      type: "frame_update",
      status,
      agent_name: AGENT_NAME,
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
