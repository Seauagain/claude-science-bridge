import WebSocket from "ws";
import type { DaemonEndpoint } from "./endpoint.ts";
import { ScienceDaemonError } from "./errors.ts";
import type { Login } from "./login.ts";
import { isRecord, type JsonRecord } from "./validate.ts";

/** One message pushed by the daemon. Only `type` is guaranteed; read other fields defensively. */
export type DaemonEvent = JsonRecord & { readonly type: string };

/**
 * The daemon's event socket. One socket carries events for all of the user's conversations, so
 * every listener must filter by conversation.
 */
export interface DaemonSocket {
  /** Registers a listener for every event. Returns a function that removes it. */
  onEvent(listener: (event: DaemonEvent) => void): () => void;
  close(): void;
}

/** Opens the event socket for `userId`. Resolves once the handshake has completed. */
export function openDaemonSocket(
  endpoint: DaemonEndpoint,
  login: Login,
  userId: string,
): Promise<DaemonSocket> {
  const listeners = new Set<(event: DaemonEvent) => void>();
  const socket = new WebSocket(
    `${endpoint.socketUrl}?user_id=${encodeURIComponent(userId)}`,
    [`operon-csrf.${login.csrfToken}`],
    { headers: { cookie: login.cookieHeader, origin: endpoint.origin } },
  );

  socket.on("message", (data) => {
    const event = parseEvent(String(data));
    if (event === undefined) return;
    for (const listener of [...listeners]) listener(event);
  });

  return new Promise((resolve, reject) => {
    const refuse = (reason: string) =>
      reject(
        new ScienceDaemonError(
          "unreachable",
          `Could not open the event connection to Claude Science (${reason}).`,
        ),
      );
    socket.once("unexpected-response", (_request, response) => {
      refuse(`HTTP ${response.statusCode}`);
      socket.terminate();
    });
    socket.once("error", (error) => refuse(error.message));
    socket.once("open", () => {
      // After the handshake, errors surface as a close. Keep the process alive through them.
      socket.on("error", () => {});
      resolve({
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close: () => socket.close(),
      });
    });
  });
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
