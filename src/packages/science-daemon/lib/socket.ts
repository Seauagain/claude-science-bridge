import WebSocket from "ws";
import { type DaemonAccess, LOGIN_NOT_RENEWED } from "./access.ts";
import { ScienceDaemonError } from "./errors.ts";
import { type Heartbeat, keepAlive } from "./heartbeat.ts";
import type { Login } from "./login.ts";
import { type ConnectionTiming, MAX_RECONNECT_DELAY_MS } from "./timing.ts";
import { isRecord, type JsonRecord } from "./validate.ts";

/** One message pushed by the daemon. Only `type` is guaranteed; read other fields defensively. */
export type DaemonEvent = JsonRecord & { readonly type: string };

/**
 * The daemon's event socket. One socket carries events for all of the user's conversations, so
 * every listener must filter by conversation.
 *
 * The socket is pinged, and opened again when it drops or a pong stays away. See "WebSocket" in
 * docs/protocol.md.
 */
export interface DaemonSocket {
  /**
   * Resolves once the socket is open. While it is being reopened this waits for the outcome;
   * after it was given up this makes one more attempt.
   *
   * @throws ScienceDaemonError with kind `unreachable` when the socket cannot be opened.
   */
  ready(): Promise<void>;
  /** Registers a listener for everything that happens. Returns a function that removes it. */
  onSignal(listener: (signal: SocketSignal) => void): () => void;
  /** Closes the socket for good. Listeners are told nothing further. */
  close(): void;
}

/** What a listener on the event socket is told. */
export type SocketSignal =
  | { readonly kind: "event"; readonly event: DaemonEvent }
  /**
   * The socket had dropped and is open again. Events sent in between are lost. Told before any
   * event of the new socket.
   */
  | { readonly kind: "reconnected" }
  /** The socket dropped and could not be reopened in the time allowed. */
  | { readonly kind: "gone"; readonly error: ScienceDaemonError };

const CLOSED = "The connection to Claude Science has been closed.";

/** Opens the event socket for `userId`. Resolves once the handshake has completed. */
export async function openDaemonSocket(
  access: DaemonAccess,
  userId: string,
  timing: ConnectionTiming,
): Promise<DaemonSocket> {
  const socket = new EventSocket(access, userId, timing);
  await socket.open();
  return socket;
}

class EventSocket implements DaemonSocket {
  readonly #access: DaemonAccess;
  readonly #userId: string;
  readonly #timing: ConnectionTiming;
  readonly #listeners = new Set<(signal: SocketSignal) => void>();
  /** The open socket and what keeps it alive. Undefined while there is none. */
  #current: { readonly socket: WebSocket; readonly heartbeat: Heartbeat } | undefined;
  /** Whether a socket has been open before: the next one to open is a reconnection. */
  #wasOpen = false;
  /** The attempt to reopen a dropped socket, while one is under way. */
  #reopening: Promise<void> | undefined;
  #closed = false;
  /** Ends the wait between two attempts to reopen the socket. */
  #stopWaiting = () => {};

  constructor(access: DaemonAccess, userId: string, timing: ConnectionTiming) {
    this.#access = access;
    this.#userId = userId;
    this.#timing = timing;
  }

  /**
   * Makes one attempt to open the socket. A handshake the daemon answers with 401 gets one new
   * login and one more try, like a request.
   */
  async open(): Promise<void> {
    const login = this.#access.login;
    if ((await this.#handshake(login)) === "open") return;
    if ((await this.#handshake(await this.#access.renewLogin(login))) === "open") return;
    throw new ScienceDaemonError(
      "login-failed",
      `${LOGIN_NOT_RENEWED} Claude Science turned away a new login as well. ` +
        "Run `csbridge doctor` to check the login, then send the prompt again.",
    );
  }

  ready(): Promise<void> {
    if (this.#current !== undefined) return Promise.resolve();
    // Either the socket is being reopened, and the caller waits for the outcome, or it was given
    // up earlier, and whoever needs the daemon now gets one fresh attempt.
    return this.#reopening ?? this.#reopen(0);
  }

  onSignal(listener: (signal: SocketSignal) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#stopWaiting();
    this.#current?.heartbeat.stop();
    this.#current?.socket.close();
  }

  #handshake(login: Login): Promise<"open" | "login-rejected"> {
    const { endpoint } = this.#access;
    const socket = new WebSocket(
      `${endpoint.socketUrl}?user_id=${encodeURIComponent(this.#userId)}`,
      [`operon-csrf.${login.csrfToken}`],
      { headers: { cookie: login.cookieHeader, origin: endpoint.origin } },
    );

    return new Promise((resolve, reject) => {
      const refuse = (reason: string) =>
        reject(
          new ScienceDaemonError(
            "unreachable",
            `Could not open the event connection to Claude Science (${reason}).`,
          ),
        );
      socket.once("unexpected-response", (_request, response) => {
        if (response.statusCode === 401) resolve("login-rejected");
        else refuse(`HTTP ${response.statusCode}`);
        socket.terminate();
      });
      // After the handshake, errors surface as a close. Keep the process alive through them.
      socket.on("error", (error) => refuse(error.message));
      socket.once("open", () => {
        if (this.#closed) {
          // Closed while the handshake was under way: nobody wants this socket any more.
          socket.terminate();
          reject(new ScienceDaemonError("unreachable", CLOSED));
          return;
        }
        this.#adopt(socket);
        resolve("open");
      });
    });
  }

  #adopt(socket: WebSocket): void {
    const heartbeat = keepAlive(socket, this.#timing);
    this.#current = { socket, heartbeat };
    socket.on("message", (data) => {
      const event = parseEvent(String(data));
      if (event === undefined) return;
      if (event.type === "pong") heartbeat.pongReceived();
      else this.#tell({ kind: "event", event });
    });
    socket.once("close", () => {
      heartbeat.stop();
      this.#current = undefined;
      if (this.#closed) return;
      // Nobody awaits this unless they call `ready`: the listeners are told how it went.
      this.#reopen(this.#timing.reconnectGiveUpMs).catch(() => {});
    });
    // Told here, in the same step that starts the new socket's events, so that no listener can
    // take an event of the new socket for the continuation of what it saw on the old one.
    if (this.#wasOpen) this.#tell({ kind: "reconnected" });
    this.#wasOpen = true;
  }

  #tell(signal: SocketSignal): void {
    for (const listener of [...this.#listeners]) listener(signal);
  }

  /**
   * Opens the socket again, trying for `keepTryingMs`. Success is told to the listeners when
   * the new socket opens; failure is told to them here and thrown.
   */
  #reopen(keepTryingMs: number): Promise<void> {
    this.#reopening = this.#openWithRetries(Date.now() + keepTryingMs)
      .catch((cause: unknown) => {
        const reason = cause instanceof ScienceDaemonError ? ` ${cause.message}` : "";
        const error = new ScienceDaemonError(
          "unreachable",
          `The connection to Claude Science was lost and could not be restored.${reason}`,
          { cause },
        );
        if (!this.#closed) this.#tell({ kind: "gone", error });
        throw error;
      })
      .finally(() => {
        this.#reopening = undefined;
      });
    return this.#reopening;
  }

  /**
   * Opens the socket, waiting longer after every failed attempt, until `giveUpAt`. Each attempt
   * first asks where the daemon is: after a restart it may listen on another port.
   */
  async #openWithRetries(giveUpAt: number): Promise<void> {
    let delay = this.#timing.reconnectDelayMs;
    for (;;) {
      try {
        if (this.#closed) throw new ScienceDaemonError("unreachable", CLOSED);
        await this.#access.relocate();
        await this.open();
        return;
      } catch (error) {
        if (this.#closed || Date.now() + delay > giveUpAt) throw error;
      }
      await this.#wait(delay);
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  #wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      this.#stopWaiting = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

function parseEvent(text: string): DaemonEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const type = parsed.type;
  return typeof type === "string" ? { ...parsed, type } : undefined;
}
