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
  #answeringPings = true;
  /** Callers of {@link nextOpened} and {@link nextPing} that are still waiting. */
  #awaitingSocket: (() => void)[] = [];
  #awaitingPing: (() => void)[] = [];

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

  /** While false, pings get no pong. */
  answerPings(answer: boolean): void {
    this.#answeringPings = answer;
  }

  /** Resolves the next time a client opens a socket. */
  nextOpened(): Promise<void> {
    return new Promise((resolve) => this.#awaitingSocket.push(resolve));
  }

  /** Resolves the next time a ping arrives. */
  nextPing(): Promise<void> {
    return new Promise((resolve) => this.#awaitingPing.push(resolve));
  }

  close(): void {
    this.drop();
    this.#server.close();
  }

  #serve(client: WebSocket): void {
    client.on("message", (data) => {
      const message: unknown = JSON.parse(String(data));
      if (!isRecord(message) || message.type !== "ping") return;
      if (this.#answeringPings) client.send('{"type":"pong"}');
      for (const resolve of this.#awaitingPing.splice(0)) resolve();
    });
    // The real daemon pushes events nobody asked for; clients must ignore them.
    client.send(JSON.stringify({ type: "environment_status", environments: [] }));
    for (const resolve of this.#awaitingSocket.splice(0)) resolve();
  }
}
