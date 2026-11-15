import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

/** What the fake daemon answers to one request: an HTTP status and a JSON body. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0)
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return cookies;
}

export function readBody(request: IncomingMessage): Promise<string> {
  return text(request);
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
