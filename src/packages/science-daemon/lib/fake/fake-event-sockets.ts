import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { isRecord, type JsonRecord } from "../validate.ts";

/** The fake daemon's event sockets. See "WebSocket" in docs/protocol.md. */
export class FakeEventSockets {
  readonly #server = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => [...offered][0] ?? false,
  });

  /** Completes a handshake the daemon accepts and starts serving the socket. */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#server.handleUpgrade(request, socket, head, (client) => this.#serve(client));
  }

  /** Pushes an event to every open socket: one socket carries all of the user's conversations. */
  broadcast(event: JsonRecord): void {
    const text = JSON.stringify(event);
    for (const socket of this.#server.clients) socket.send(text);
  }

  /** How many sockets are open right now. */
  get count(): number {
    return this.#server.clients.size;
  }

  /** Cuts every open socket without a closing handshake. */
  drop(): void {
    for (const socket of this.#server.clients) socket.terminate();
  }

  close(): void {
    this.drop();
    this.#server.close();
  }

  #serve(client: WebSocket): void {
    client.on("message", (data) => {
      const message: unknown = JSON.parse(String(data));
      if (isRecord(message) && message.type === "ping") client.send('{"type":"pong"}');
    });
    // The real daemon pushes events nobody asked for; clients must ignore them.
    client.send(JSON.stringify({ type: "environment_status", environments: [] }));
  }
}
