import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Answer, parseCookies, readBody, sendJson } from "./http-exchange.ts";

/**
 * The fake daemon's side of "Login" and "Requests" in docs/protocol.md: login links, the cookie
 * pair, and the checks every logged-in request and socket handshake must pass.
 */
export class FakeLogins {
  readonly #nonces = new Set<string>();
  readonly #logins = new Set<string>();
  /** CSRF tokens the daemon issued and still takes. */
  readonly #csrfTokens = new Set<string>();
  #issuedCount = 0;
  #accepting = true;

  /** How many logins have been issued so far. */
  get issuedCount(): number {
    return this.#issuedCount;
  }

  /** Forgets every login issued so far, as the daemon does when they expire. */
  expire(): void {
    this.#logins.clear();
  }

  /** While false, no login counts as logged in, not even one issued a moment ago. */
  accept(accept: boolean): void {
    this.#accepting = accept;
  }

  /** The nonce of a new single-use login link. */
  issueNonce(): string {
    const nonce = randomBytes(16).toString("hex");
    this.#nonces.add(nonce);
    return nonce;
  }

  /** Makes every CSRF token issued so far stale. */
  expireCsrfTokens(): void {
    this.#csrfTokens.clear();
  }

  /** `GET /`: the confirmation page of a login link, which sets the CSRF cookie. */
  servePage(response: ServerResponse): void {
    this.#setCsrfCookie(response);
    response.writeHead(200, { "content-type": "text/html" }).end("<form></form>");
  }

  /**
   * `GET /api/csrf`: sets a new CSRF cookie. docs/protocol.md does not say what the body is; the
   * fake sends an empty object.
   */
  refreshCsrfToken(response: ServerResponse): void {
    this.#setCsrfCookie(response);
    sendJson(response, 200, {});
  }

  /** `POST /api/auth/nonce`: exchanges an unused nonce for the login cookie. */
  async exchangeNonce(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const nonce = new URLSearchParams(await readBody(request)).get("nonce") ?? "";
    if (!this.#nonces.delete(nonce)) {
      return sendJson(response, 401, { detail: "Invalid or expired nonce" });
    }
    const login = randomBytes(16).toString("hex");
    this.#logins.add(login);
    this.#issuedCount += 1;
    response.setHeader("set-cookie", `operon_auth=${login}; Path=/; HttpOnly`);
    sendJson(response, 200, { ok: true });
  }

  /** The error a request to an `/api` route is answered with, or undefined when it may proceed. */
  refusal(request: IncomingMessage, origin: string): Answer | undefined {
    const cookies = parseCookies(request);
    if (!this.#isLoggedIn(cookies)) return { status: 401, body: { detail: "Not authenticated" } };
    if (request.method !== "POST") return undefined;

    const token = cookies.get("operon_csrf");
    const valid =
      token !== undefined &&
      request.headers["x-operon-csrf"] === token &&
      request.headers.origin === origin;
    if (!valid) {
      return { status: 403, body: { detail: "CSRF check failed", code: "csrf_invalid" } };
    }
    if (!this.#csrfTokens.has(token)) {
      return { status: 403, body: { detail: "CSRF token stale", code: "csrf_stale" } };
    }
    return undefined;
  }

  /** Whether a handshake for the event socket carries what "WebSocket" in protocol.md asks for. */
  acceptsSocket(request: IncomingMessage, origin: string): boolean {
    const cookies = parseCookies(request);
    const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",");
    const expected = `operon-csrf.${cookies.get("operon_csrf")}`;
    return (
      this.#isLoggedIn(cookies) &&
      offered.some((protocol) => protocol.trim() === expected) &&
      request.headers.origin === origin
    );
  }

  #setCsrfCookie(response: ServerResponse): void {
    const token = randomBytes(16).toString("hex");
    this.#csrfTokens.add(token);
    response.setHeader("set-cookie", `operon_csrf=${token}; Path=/`);
  }

  #isLoggedIn(cookies: Map<string, string>): boolean {
    return this.#accepting && this.#logins.has(cookies.get("operon_auth") ?? "");
  }
}
