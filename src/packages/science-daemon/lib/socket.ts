import WebSocket from "ws";
import { type DaemonAccess, LOGIN_NOT_RENEWED } from "./access.ts";
import { ScienceDaemonError } from "./errors.ts";
import type { Login } from "./login.ts";
import { isRecord, type JsonRecord } from "./validate.ts";

/** One message pushed by the daemon. Only `type` is guaranteed; read other fields defensively. */
export type DaemonEvent = JsonRecord & { readonly type: string };

/**
 * How patient the connection to the daemon is, in milliseconds. The defaults suit the real
 * daemon; tests pass shorter values.
 */
export interface ConnectionTiming {
  /** How often the event socket is pinged. Default: 25 000, as the daemon's web client does. */
  readonly pingIntervalMs: number;
  /** How long a pong may take before the socket counts as dropped. Default: 10 000. */
  readonly pongTimeoutMs: number;
  /**
   * How long to wait after the first failed attempt to reopen a dropped socket. The wait doubles
   * with every further attempt, up to ten seconds. Default: 1 000.
   */
  readonly reconnectDelayMs: number;
  /**
   * How long to keep trying to reopen a dropped socket. After that, running turns end with an
   * error; the next message makes a fresh attempt. Default: 60 000.
   */
  readonly reconnectGiveUpMs: number;
}

export const DEFAULT_TIMING: ConnectionTiming = {
  pingIntervalMs: 25_000,
  pongTimeoutMs: 10_000,
  reconnectDelayMs: 1_000,
  reconnectGiveUpMs: 60_000,
};

const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * The daemon's event socket. One socket carries events for all of the user's conversations, so
 * every listener must filter by conversation.
 *
 * The socket is pinged, and opened again when it drops or a pong stays away. See "WebSocket" in
 * docs/protocol.md.
 */
export interface DaemonSocket {
  /** Registers a listener for every event. Returns a function that removes it. */
  onEvent(listener: (event: DaemonEvent) => void): () => void;
  close(): void;
}

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
  readonly #listeners = new Set<(event: DaemonEvent) => void>();
  /** The open socket and what keeps it alive. Undefined while there is none. */
  #current: { readonly socket: WebSocket; readonly heartbeat: Heartbeat } | undefined;
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

  onEvent(listener: (event: DaemonEvent) => void): () => void {
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
          refuse("the connection was closed");
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
      for (const listener of [...this.#listeners]) listener(event);
    });
    socket.once("close", () => {
      heartbeat.stop();
      this.#current = undefined;
      if (!this.#closed) this.#reopen(Date.now() + this.#timing.reconnectGiveUpMs).catch(() => {});
    });
  }

  /**
   * Opens the socket again, waiting longer after every failed attempt, until `giveUpAt`. Each
   * attempt first asks where the daemon is: after a restart it may listen on another port.
   */
  async #reopen(giveUpAt: number): Promise<void> {
    let delay = this.#timing.reconnectDelayMs;
    for (;;) {
      try {
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

interface Heartbeat {
  pongReceived(): void;
  stop(): void;
}

/**
 * Pings `socket` at regular intervals and cuts it when a pong stays away, so that a socket that
 * died without a close does not go unnoticed.
 */
function keepAlive(socket: WebSocket, timing: ConnectionTiming): Heartbeat {
  let deadline: NodeJS.Timeout | undefined;
  const interval = setInterval(() => {
    socket.send('{"type":"ping"}');
    // One deadline at a time: it runs from the first ping that went unanswered.
    deadline ??= setTimeout(() => socket.terminate(), timing.pongTimeoutMs);
  }, timing.pingIntervalMs);
  return {
    pongReceived() {
      clearTimeout(deadline);
      deadline = undefined;
    },
    stop() {
      clearInterval(interval);
      clearTimeout(deadline);
    },
  };
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
