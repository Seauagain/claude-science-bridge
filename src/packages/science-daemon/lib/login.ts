import type { DaemonEndpoint } from "./endpoint.ts";
import { ScienceDaemonError } from "./errors.ts";
import { runScienceCli, type ScienceCli } from "./science-cli.ts";
import { withinTimeLimit } from "./time-limit.ts";

/** The cookie pair the daemon issues for a login link. Kept in memory only, never logged. */
export interface Login {
  /** The cookies by name, kept so that a refreshed one can replace its predecessor. */
  readonly cookies: ReadonlyMap<string, string>;
  /** Value for the `cookie` header of every request. */
  readonly cookieHeader: string;
  /** Value for the `x-operon-csrf` header of writes and for the socket subprotocol. */
  readonly csrfToken: string;
}

const AUTH_COOKIE = "operon_auth";
const CSRF_COOKIE = "operon_csrf";

/**
 * Logs in the way the browser does: obtains a single-use login link from the Science CLI and
 * exchanges its nonce for cookies. See "Login" in docs/protocol.md. The daemon gets
 * `requestTimeoutMs` to answer each of the two requests.
 */
export async function logIn(
  endpoint: DaemonEndpoint,
  scienceCli: ScienceCli,
  requestTimeoutMs: number,
): Promise<Login> {
  const nonce = extractNonce(await runScienceCli(scienceCli, ["url"]));
  const cookies = new Map<string, string>();

  // Only the nonce is taken from the link. Requests go to the located loopback endpoint.
  const page = await request(
    `${endpoint.baseUrl}/?nonce=${encodeURIComponent(nonce)}`,
    {},
    requestTimeoutMs,
  );
  collectCookies(page, cookies);

  const exchange = await request(
    `${endpoint.baseUrl}/api/auth/nonce`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(cookies),
        origin: endpoint.origin,
      },
      body: new URLSearchParams({ nonce, dest: "/" }).toString(),
    },
    requestTimeoutMs,
  );
  collectCookies(exchange, cookies);

  const csrfToken = cookies.get(CSRF_COOKIE);
  if (!cookies.has(AUTH_COOKIE) || csrfToken === undefined) {
    throw new ScienceDaemonError(
      "login-failed",
      `Claude Science did not accept the login link (HTTP ${exchange.status}). ` +
        "Check that `claude-science url` works in a terminal, then try again.",
    );
  }
  return { cookies, cookieHeader: cookieHeader(cookies), csrfToken };
}

/**
 * Asks the daemon for a new CSRF token, which it wants once it calls the current one stale, and
 * returns the login that carries it. See "Requests" in docs/protocol.md.
 *
 * The token is taken from the cookie the response sets. Without one the login comes back as it
 * was, and the daemon's next answer says what is wrong.
 */
export async function refreshCsrfToken(
  endpoint: DaemonEndpoint,
  login: Login,
  requestTimeoutMs: number,
): Promise<Login> {
  const cookies = new Map(login.cookies);
  const response = await request(
    `${endpoint.baseUrl}/api/csrf`,
    { headers: { cookie: login.cookieHeader } },
    requestTimeoutMs,
  );
  collectCookies(response, cookies);
  return {
    cookies,
    cookieHeader: cookieHeader(cookies),
    csrfToken: cookies.get(CSRF_COOKIE) ?? login.csrfToken,
  };
}

function extractNonce(cliOutput: string): string {
  const link = cliOutput.trim().split("\n")[0] ?? "";
  let nonce: string | null = null;
  try {
    nonce = new URL(link).searchParams.get("nonce");
  } catch {
    // Reported below without echoing the output, which may hold a nonce.
  }
  if (nonce) return nonce;
  throw new ScienceDaemonError(
    "science-cli-failed",
    '"claude-science url" did not print a login link csbridge understands.',
  );
}

/** One request of the login, which the daemon gets `timeoutMs` to answer. */
function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return withinTimeLimit(
    timeoutMs,
    (signal) => fetch(url, { ...init, redirect: "manual", signal }),
    " to log in",
  );
}

function collectCookies(response: Response, cookies: Map<string, string>): void {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0)
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
