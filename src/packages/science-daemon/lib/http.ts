import type { DaemonEndpoint } from "./endpoint.ts";
import { ScienceDaemonError } from "./errors.ts";
import type { Login } from "./login.ts";
import { isRecord } from "./validate.ts";

/** Logged-in JSON requests against the daemon's `/api` routes. */
export interface DaemonHttp {
  /** `path` is relative to `/api` and starts with a slash. Returns the parsed JSON body. */
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

export function createDaemonHttp(endpoint: DaemonEndpoint, login: Login): DaemonHttp {
  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    const call = `${method} ${path}`;
    const headers: Record<string, string> = { cookie: login.cookieHeader };
    if (method === "POST") {
      // Writes need the CSRF header and the daemon's own origin. See docs/protocol.md.
      headers["content-type"] = "application/json";
      headers["x-operon-csrf"] = login.csrfToken;
      headers.origin = endpoint.origin;
    }

    let response: Response;
    try {
      response = await fetch(`${endpoint.baseUrl}/api${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new ScienceDaemonError(
        "unreachable",
        "Could not reach Claude Science. Check that it is still running (`claude-science status`).",
        { cause },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new ScienceDaemonError(
        "rejected",
        `Claude Science refused "${call}" (HTTP ${response.status}): ${errorDetail(text)}`,
      );
    }
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
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

/** The human-readable reason from an error body, as the daemon's own web client reads it. */
function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      for (const field of ["detail", "error", "message"]) {
        const value = parsed[field];
        if (typeof value === "string" && value !== "") return value;
      }
    }
  } catch {
    // Not JSON: fall through.
  }
  return "no reason given";
}
