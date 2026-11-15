import { type DaemonAccess, newLoginRejected } from "./access.ts";
import { ScienceDaemonError } from "./errors.ts";
import type { Login } from "./login.ts";
import { withinTimeLimit } from "./time-limit.ts";
import { isRecord, type JsonRecord } from "./validate.ts";

/** Logged-in JSON requests against the daemon's `/api` routes. */
export interface DaemonHttp {
  /** `path` is relative to `/api` and starts with a slash. Returns the parsed JSON body. */
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

interface HttpAnswer {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Requests that recover by themselves from a login the daemon no longer accepts (one new login,
 * one retry) and from a CSRF token it calls stale (one new token, one retry). See "Requests" and
 * "Recovery" in docs/protocol.md. Every single request gets the time limit of `access`.
 */
export function createDaemonHttp(access: DaemonAccess): DaemonHttp {
  const exchange = async (
    login: Login,
    method: "GET" | "POST",
    path: string,
    body: unknown,
  ): Promise<HttpAnswer> => {
    const { endpoint } = access;
    const headers: Record<string, string> = { cookie: login.cookieHeader };
    if (method === "POST") {
      // Writes need the CSRF header and the daemon's own origin. See docs/protocol.md.
      headers["content-type"] = "application/json";
      headers["x-operon-csrf"] = login.csrfToken;
      headers.origin = endpoint.origin;
    }
    return withinTimeLimit(access.requestTimeoutMs, async (signal) => {
      const response = await fetch(`${endpoint.baseUrl}/api${path}`, {
        method,
        headers,
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, ok: response.ok, text: await response.text() };
    });
  };

  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    const call = `${method} ${path}`;
    const login = access.login;
    let answer = await exchange(login, method, path, body);
    // A 401 means the login is gone. The daemon did not act on the request, so it is safe to
    // send it again.
    if (answer.status === 401) {
      answer = await exchange(await access.renewLogin(login), method, path, body);
      if (answer.status === 401) throw newLoginRejected();
    } else if (hasStaleCsrfToken(answer)) {
      answer = await exchange(await access.refreshCsrfToken(login), method, path, body);
    }

    if (!answer.ok) {
      throw new ScienceDaemonError(
        answer.status === 404 ? "not-found" : "rejected",
        `Claude Science refused "${call}" (HTTP ${answer.status}): ${errorDetail(answer.text)}`,
      );
    }
    if (answer.text === "") return undefined;
    try {
      return JSON.parse(answer.text);
    } catch (cause) {
      throw new ScienceDaemonError("unexpected-response", `"${call}" did not answer with JSON.`, {
        cause,
      });
    }
  };

  return {
    get: (path) => send("GET", path),
    post: (path, body) => send("POST", path, body),
  };
}

/** Whether the daemon refused a write only because its CSRF token must be fetched anew. */
function hasStaleCsrfToken(answer: HttpAnswer): boolean {
  return answer.status === 403 && errorBody(answer.text).code === "csrf_stale";
}

/** The human-readable reason from an error body, as the daemon's own web client reads it. */
function errorDetail(body: string): string {
  const parsed = errorBody(body);
  for (const field of ["detail", "error", "message"]) {
    const value = parsed[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return "no reason given";
}

/** The fields of an error body, or none when it is not a JSON object. */
function errorBody(body: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Not JSON: an error without fields.
  }
  return {};
}
