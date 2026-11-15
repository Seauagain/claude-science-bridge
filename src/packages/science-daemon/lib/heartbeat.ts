import type WebSocket from "ws";
import type { ConnectionTiming } from "./timing.ts";

/** The pings that keep one socket alive. */
export interface Heartbeat {
  /** Tells the heartbeat that the daemon answered a ping. */
  pongReceived(): void;
  stop(): void;
}

/**
 * Pings `socket` at regular intervals and cuts it when a pong stays away, so that a socket that
 * died without a close does not go unnoticed. See "WebSocket" in docs/protocol.md.
 */
export function keepAlive(socket: WebSocket, timing: ConnectionTiming): Heartbeat {
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
