/**
 * How patient the connection to the daemon is, in milliseconds. The defaults suit the real
 * daemon; tests pass shorter values.
 */
export interface ConnectionTiming {
  /**
   * How long the daemon may take to answer any single request: an HTTP request, a step of the
   * login, or the handshake of the event socket. A request that runs out of time fails as
   * `unreachable`. Default: 30 000.
   */
  readonly requestTimeoutMs: number;
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
  requestTimeoutMs: 30_000,
  pingIntervalMs: 25_000,
  pongTimeoutMs: 10_000,
  reconnectDelayMs: 1_000,
  reconnectGiveUpMs: 60_000,
};

/** The longest wait between two attempts to reopen a dropped socket. */
export const MAX_RECONNECT_DELAY_MS = 10_000;
