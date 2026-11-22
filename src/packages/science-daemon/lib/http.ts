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
  /** Sends one file as a `multipart/form-data` body, in its field `file`. */
  upload(path: string, file: UploadedFile): Promise<unknown>;
  /**
   * Fetches a file. A file the daemon says is longer than `mostBytes` is not read.
   *
   * @throws ScienceDaemonError with kind `rejected` for a file that is longer than that.
   */
  download(path: string, mostBytes: number): Promise<DownloadedFile>;
}

/** A file the daemon sent: what {@link DaemonHttp.download} resolves to. */
export interface DownloadedFile {
  /** The media type the daemon named, or an empty string when it named none. */
  readonly contentType: string;
  /** The file's name as the daemon gave it, when it gave one. */
  readonly filename: string | undefined;
  readonly data: Uint8Array;
}

/** A file for {@link DaemonHttp.upload}. */
export interface UploadedFile {
  readonly name: string;
  /** The file's media type, or an empty string to let the daemon tell by the name. */
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/** What a request carries: nothing, a JSON value, or a file. */
type Payload = { readonly json: unknown } | { readonly file: UploadedFile } | undefined;

interface HttpAnswer {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  /** The body, or nothing for one that was left unread because it is longer than was asked for. */
  readonly body: Uint8Array | undefined;
  /** The body as text. */
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
    payload: Payload,
    mostBytes = Number.POSITIVE_INFINITY,
  ): Promise<HttpAnswer> => {
    const { endpoint } = access;
    const headers: Record<string, string> = { cookie: login.cookieHeader };
    if (method === "POST") {
      // Writes need the CSRF header and the daemon's own origin. See docs/protocol.md.
      // A file goes out as a form, whose content type `fetch` writes with its boundary.
      if (payload === undefined || "json" in payload) headers["content-type"] = "application/json";
      headers["x-operon-csrf"] = login.csrfToken;
      headers.origin = endpoint.origin;
    }
    return withinTimeLimit(access.requestTimeoutMs, async (signal) => {
      const response = await fetch(`${endpoint.baseUrl}/api${path}`, {
        method,
        headers,
        signal,
        ...bodyOf(payload),
      });
      const answer = { status: response.status, ok: response.ok, headers: response.headers };
      // Only a file is ever too long: an error is read whatever its length, to be reported.
      if (response.ok && Number(response.headers.get("content-length")) > mostBytes) {
        await response.body?.cancel();
        return { ...answer, body: undefined, text: "" };
      }
      const body = new Uint8Array(await response.arrayBuffer());
      return { ...answer, body, text: new TextDecoder().decode(body) };
    });
  };

  /** The daemon's answer to a request, once it is not an error. */
  const answerTo = async (
    method: "GET" | "POST",
    path: string,
    body?: Payload,
    mostBytes?: number,
  ): Promise<HttpAnswer> => {
    const login = access.login;
    let answer = await exchange(login, method, path, body, mostBytes);
    // A 401 means the login is gone. The daemon did not act on the request, so it is safe to
    // send it again.
    if (answer.status === 401) {
      answer = await exchange(await access.renewLogin(login), method, path, body, mostBytes);
      if (answer.status === 401) throw newLoginRejected();
    } else if (hasStaleCsrfToken(answer)) {
      answer = await exchange(await access.refreshCsrfToken(login), method, path, body, mostBytes);
    }

    if (!answer.ok) {
      throw new ScienceDaemonError(
        answer.status === 404 ? "not-found" : "rejected",
        `Claude Science refused "${method} ${path}" (HTTP ${answer.status}): ` +
          errorDetail(answer.text),
      );
    }
    return answer;
  };

  const send = async (method: "GET" | "POST", path: string, body?: Payload): Promise<unknown> => {
    const call = `${method} ${path}`;
    const answer = await answerTo(method, path, body);
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
    post: (path, body) => send("POST", path, body === undefined ? undefined : { json: body }),
    upload: (path, file) => send("POST", path, { file }),
    async download(path, mostBytes) {
      const { headers, body } = await answerTo("GET", path, undefined, mostBytes);
      if (body === undefined) {
        throw new ScienceDaemonError(
          "rejected",
          `"GET ${path}" answers with a file of more than ${mostBytes} bytes, which is not read.`,
        );
      }
      return {
        contentType: headers.get("content-type") ?? "",
        filename: filenameIn(headers.get("content-disposition") ?? ""),
        data: body,
      };
    },
  };
}

/**
 * The file name a `Content-Disposition` header gives: the one in `filename*`, which holds a name
 * that is not ASCII, before the one in `filename`. See "Artifacts" in docs/protocol.md.
 */
function filenameIn(disposition: string): string | undefined {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // Not percent-encoded after all: the plain name is next.
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1];
}

/** The `fetch` body of a payload. A form is built anew for each attempt. */
function bodyOf(payload: Payload): { body?: string | FormData } {
  if (payload === undefined) return {};
  if ("json" in payload)
    return payload.json === undefined ? {} : { body: JSON.stringify(payload.json) };
  const { name, mimeType, data } = payload.file;
  const form = new FormData();
  // Copied, because a `Blob` takes only bytes that are known not to be shared memory.
  form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), name);
  return { body: form };
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
