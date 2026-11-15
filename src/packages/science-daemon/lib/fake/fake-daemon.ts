import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ScienceCli } from "../science-cli.ts";
import type { JsonRecord } from "../validate.ts";
import type { ExistingConversation, FakeConversation, ReplyScript } from "./fake-conversation.ts";
import { FakeConversations } from "./fake-conversations.ts";
import { FakeEventSockets } from "./fake-event-sockets.ts";
import { FakeLogins } from "./fake-logins.ts";
import { type FakeProject, FakeProjects } from "./fake-projects.ts";
import type { FakeScienceDaemon } from "./fake-science-daemon.ts";
import { type Answer, readBody, sendJson, undocumented } from "./http-exchange.ts";

/** The daemon version docs/protocol.md was observed on. */
const OBSERVED_VERSION = "0.1.53";

/**
 * Starts a fake daemon on a free loopback port and resolves once it listens. It starts out with
 * no projects and no conversations, accepts login links from its own Science CLI stand-in, and
 * answers as docs/protocol.md says until a test tells it otherwise. It holds a port and open
 * sockets: close it when the test is done.
 */
export async function startFakeScienceDaemon(): Promise<FakeScienceDaemon> {
  const daemon = new FakeDaemon();
  await daemon.start();
  return daemon;
}

/** Serves HTTP and the socket handshake, and hands each request to the part that answers it. */
class FakeDaemon implements FakeScienceDaemon {
  readonly #server: Server;
  readonly #logins = new FakeLogins();
  readonly #sockets = new FakeEventSockets();
  readonly #conversations = new FakeConversations((event) => this.#sockets.broadcast(event));
  readonly #projects = new FakeProjects();
  readonly #responseOverrides = new Map<string, unknown>();
  /** Sockets whose handshake was left unanswered, kept so that stopping the daemon cuts them. */
  readonly #unansweredHandshakes = new Set<Duplex>();
  #port = 0;
  #running = true;
  #answering = true;
  #version = OBSERVED_VERSION;

  constructor() {
    this.#server = createServer((request, response) => {
      // A request that arrives while the daemon does not answer is never answered.
      if (!this.#answering) return;
      this.#handle(request, response).catch((error: unknown) => {
        sendJson(response, 500, { detail: `fake daemon bug: ${String(error)}` });
      });
    });
    this.#server.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake daemon: the server is not listening on a TCP port");
    }
    this.#port = address.port;
  }

  readonly scienceCli: ScienceCli = async (args) => {
    if (args[0] === "status") {
      // What the real program prints besides `running` when no daemon is up is not known.
      if (!this.#running || !this.#server.listening) return JSON.stringify({ running: false });
      return JSON.stringify({ running: true, version: this.#version, port: this.#port });
    }
    if (args[0] === "url") {
      return `http://localhost:${this.#port}/?nonce=${this.#logins.issueNonce()}\n`;
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

  expireLogins(): void {
    this.#logins.expire();
  }

  acceptLogins(accept: boolean): void {
    this.#logins.accept(accept);
  }

  loginCount(): number {
    return this.#logins.issuedCount;
  }

  expireCsrfTokens(): void {
    this.#logins.expireCsrfTokens();
  }

  addProject(name: string, options: { readonly archived?: boolean } = {}): string {
    return this.#projects.add(name, options.archived ?? false);
  }

  projects(): FakeProject[] {
    return this.#projects.all();
  }

  addConversation(projectId: string, conversation: ExistingConversation): string {
    if (!this.#projects.has(projectId)) {
      throw new Error(`fake daemon: there is no project ${projectId} to add a conversation to`);
    }
    return this.#conversations.add(projectId, conversation);
  }

  onNextMessage(script: ReplyScript): void {
    this.#conversations.queueScript(script);
  }

  endTurnsOnCancel(end: boolean): void {
    this.#conversations.endTurnsOnCancel(end);
  }

  conversations(): FakeConversation[] {
    return this.#conversations.list();
  }

  cancelRequests(): string[] {
    return this.#conversations.cancelRequests();
  }

  nextTranscriptRead(): Promise<void> {
    return this.#conversations.nextTranscriptRead();
  }

  broadcast(event: JsonRecord): void {
    this.#sockets.broadcast(event);
  }

  eventConnectionCount(): number {
    return this.#sockets.count;
  }

  dropEventSockets(): void {
    this.#sockets.drop();
  }

  nextEventSocket(): Promise<void> {
    return this.#sockets.nextOpened();
  }

  nextPing(): Promise<void> {
    return this.#sockets.nextPing();
  }

  answerPings(answer: boolean): void {
    this.#sockets.answerPings(answer);
  }

  answerRequests(answer: boolean): void {
    this.#answering = answer;
  }

  async stop(): Promise<void> {
    this.#sockets.drop();
    for (const socket of this.#unansweredHandshakes) socket.destroy();
    this.#logins.expire();
    if (!this.#server.listening) return;
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async close(): Promise<void> {
    await this.stop();
    this.#sockets.close();
  }

  get #origin(): string {
    return `http://localhost:${this.#port}`;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.#origin);
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /health") return sendJson(response, 200, { status: "ok" });
    if (route === "GET /") return this.#logins.servePage(response);
    if (route === "POST /api/auth/nonce") return this.#logins.exchangeNonce(request, response);

    const refusal = this.#logins.refusal(request, this.#origin);
    if (refusal === undefined && route === "GET /api/csrf") {
      return this.#logins.refreshCsrfToken(response);
    }
    const answer = refusal ?? this.#override(route) ?? (await this.#answer(route, url, request));
    sendJson(response, answer.status, answer.body);
  }

  #override(route: string): Answer | undefined {
    if (!this.#responseOverrides.has(route)) return undefined;
    const body = this.#responseOverrides.get(route);
    this.#responseOverrides.delete(route);
    return { status: 200, body };
  }

  /** The routes of "REST endpoints used" in docs/protocol.md, for a logged-in request. */
  async #answer(route: string, url: URL, request: IncomingMessage): Promise<Answer> {
    if (route === "GET /api/me") return { status: 200, body: { user_id: "fake-user" } };
    if (route === "GET /api/projects") {
      return this.#projects.list((projectId) => this.#conversations.countIn(projectId));
    }
    if (route === "POST /api/projects") {
      return this.#projects.create(JSON.parse(await readBody(request)));
    }
    if (route === "GET /api/frames") {
      // What the daemon answers for a project it does not know is not recorded.
      return this.#projects.has(url.searchParams.get("project_id") ?? "")
        ? this.#conversations.listFrames(url.searchParams)
        : undocumented("project_id names no project");
    }
    if (route === "POST /api/request") {
      return this.#conversations.sendFurtherMessage(JSON.parse(await readBody(request)));
    }

    const [, resource, id = "", action] =
      /^\/api\/(projects|frames)\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname) ?? [];
    const target = `${request.method} ${resource}/${action ?? ""}`;
    if (target === "POST projects/request") {
      const projectId = decodeURIComponent(id);
      if (!this.#projects.has(projectId)) {
        return { status: 404, body: { detail: `Project ${projectId} not found` } };
      }
      return this.#conversations.start(projectId, JSON.parse(await readBody(request)));
    }
    if (target === "GET frames/") return this.#conversations.frame(decodeURIComponent(id));
    if (target === "GET frames/messages") {
      return this.#conversations.messages(decodeURIComponent(id), url.searchParams);
    }
    if (target === "POST frames/cancel") return this.#conversations.cancel(decodeURIComponent(id));
    return { status: 404, body: { detail: `Not found: ${route}` } };
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.#answering) {
      this.#unansweredHandshakes.add(socket);
      socket.once("close", () => this.#unansweredHandshakes.delete(socket));
      return;
    }
    const accepted =
      (request.url ?? "").startsWith("/api/ws") &&
      this.#logins.acceptsSocket(request, this.#origin);
    if (!accepted) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    this.#sockets.accept(request, socket, head);
  }
}
