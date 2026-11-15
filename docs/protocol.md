# Claude Science daemon protocol notes

Everything this project knows about the local Claude Science daemon's interface lives here and
in `src/packages/science-daemon`. The interface is internal and undocumented: treat every
statement below as an observation about one version, not a contract.

- Observed version: **0.1.53** (macOS arm64), 2026-11-15.
- The in-repo fake daemon (`science-daemon/testing.ts`) implements exactly what this file says.
  When real behaviour differs, fix this file and the fake first, then the code.

## How each fact was established

| Mark       | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| **[live]** | Observed against the real daemon with read-only calls (login, GET, WebSocket handshake). |
| **[web]**  | Read from the daemon's bundled web client code. Not yet exercised by us.                 |
| **[3p]**   | Read from third-party clients that use the same call. Not yet exercised by us.           |
| **[open]** | Unknown. Needs a live test that sends a message.                                         |

## Discovery

- `claude-science status` prints JSON and always exits 0. Fields used: `running` (boolean),
  `version` (string), `port` (number). **[live]**
- The daemon listens on loopback. `GET /health` answers 200 without a session; every `/api/*`
  route answers 401 without one. **[live]**

## Login

1. `claude-science url` prints a single-use login link on stdout, valid for about three minutes:
   `http://localhost:<port>/?nonce=<hex>`. **[live]**
2. `GET` that link returns an HTML confirmation page (200) and sets the `operon_csrf` cookie.
   The page holds a form posting to `/api/auth/nonce` with fields `nonce` and `dest`. **[live]**
3. `POST /api/auth/nonce` with `content-type: application/x-www-form-urlencoded` and body
   `nonce=<hex>&dest=/` sets the `operon_auth` session cookie (200). **[live]**
4. Session lifetime is unknown. A 401 means the session is gone: log in again. **[open]**

## Requests

- Send both cookies on every request. **[live]**
- Writes (`POST`, `PUT`, `PATCH`, `DELETE`) also need the header `x-operon-csrf: <operon_csrf
  cookie value>` and an `origin` header equal to the daemon's own origin. **[web] [3p]**
- A 403 whose JSON body has `code: "csrf_stale"` means the CSRF cookie must be refreshed
  (`GET /api/csrf`), then the write retried once. **[web]**
- Error bodies carry a human-readable string in `detail`, `error` or `message`. **[web]**

## REST endpoints used

All paths are under `/api`.

| Call                                                   | Shape                                                                                                                                                                                | Status                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `GET /me`                                              | `{ user_id, email, provider, auth_mode, ... }`                                                                                                                                       | **[live]**                  |
| `GET /projects`                                        | `{ projects: [{ project_id, name, description, conversation_count, archived_at, updated_at, ... }], total }`                                                                         | **[live]**                  |
| `GET /models`                                          | `{ models: { anthropic: [{ id, name, description, effort, ... }] }, default_model_id, default_effort, ... }`                                                                         | **[live]**                  |
| `GET /frames?root_only=true&project_id=<id>&limit=<n>` | array of frames (see below)                                                                                                                                                          | **[live]**                  |
| `GET /frames/<id>?shallow=true`                        | one frame                                                                                                                                                                            | **[live]**                  |
| `GET /frames/<id>/messages?from=<n>&limit=<n>`         | `{ frame_id, from, total, messages: [{ role, content: [blocks], _uuid, _ts }] }`                                                                                                     | **[live]**                  |
| `GET /frames/<id>/streaming`                           | text buffered so far for an in-flight reply, or `null`                                                                                                                               | **[live]** (idle case only) |
| `POST /projects/<project_id>/request`                  | body `{ input_data: { request: <text> }, model?, effort? }` → `{ frame_id, ... }`. Starts a new conversation in the project.                                                         | **[3p]**                    |
| `POST /request`                                        | body `{ root_frame_id, frame_id, input_data: { request: <text> }, intent_id, plan_mode: false, model? }` → `{ status, ... }`. Sends a follow-up message to an existing conversation. | **[web]**                   |
| `POST /frames/<root_id>/cancel`                        | cancels the running reply                                                                                                                                                            | **[web]**                   |
| `POST /frames/<id>/resolve-input`                      | body `{ responses }`. Answers pending input or approval requests.                                                                                                                    | **[web]**                   |

A **frame** has, among others: `id`, `root_frame_id`, `parent_frame_id` (null for a conversation),
`project_id`, `name`, `status`, `conversation_type` (`"agent"` for conversations the user sees),
`created_at`, `updated_at`, `model`, `effort`, `output_data`. **[live]**

Frame `status` values: `processing`, `completed`, `failed`, `success`, `replaced`, `cancelled`,
`awaiting_plan_approval`, `awaiting_user_response`. The web client treats `completed`, `failed`,
`cancelled`, `success` and `replaced` as terminal, and the two `awaiting_*` values as settled but
waiting for the user. A `processing` frame whose `has_pending_input` is true is waiting for an
approval; the requests are in `output_data.pending_input_requests`. **[web]**

## WebSocket

- URL: `ws://<host>:<port>/api/ws?user_id=<user_id from /me>`. **[live]**
- Handshake needs the cookies, an `origin` header, and the subprotocol
  `operon-csrf.<operon_csrf cookie value>`, which the server echoes back. **[live]**
- Messages are JSON objects with a `type` field, in both directions. **[live]**
- Heartbeat: the client sends `{"type":"ping"}` (the web client does so every 25 s and
  reconnects if no `pong` arrives within 10 s); the server answers `{"type":"pong"}`. **[live]**
- Subscribe to a conversation with `{"type":"view_session","root_frame_id":<id>}`; unsubscribe
  with `{"type":"unview_session","root_frame_id":<id>}`. Subscriptions must be re-sent after a
  reconnect. **[live]** (accepted without error; event delivery for a running reply is **[web]**)
- The server also pushes events nobody asked for (`environment_status`, `kernel_stats`, ...).
  Unknown event types must be ignored. **[live]**

### Events used

| `type`              | Fields                                                                                                                                                  | Meaning                                                                                               | Status    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------- |
| `text_chunk`        | `root_frame_id`, `frame_id`, `block_type` (`"text"` or `"thinking"`), `chunk`                                                                           | Next piece of the reply or of the reasoning.                                                          | **[web]** |
| `text_reset`        | `root_frame_id`, `frame_id`                                                                                                                             | Discard text streamed so far for this frame; the reply restarts.                                      | **[web]** |
| `frame_update`      | `root_frame_id`, `frame_id`, `status`                                                                                                                   | A frame changed status. For the conversation's own frame, a terminal or settled status ends the turn. | **[web]** |
| `frame_activity`    | `root_frame_id`, `frame_id`, `phase` (`llm_call`, `tool_stream`, `tool_exec`, `llm_retry`, `verifying`, `usage_limit_paused`), `tool_name?`, `tool_id?` | What the agent is doing right now.                                                                    | **[web]** |
| `tool_stdout_chunk` | `root_frame_id`, ...                                                                                                                                    | Output of a running tool.                                                                             | **[web]** |
| `rate_limit_notice` | `root_frame_id`, ...                                                                                                                                    | The reply is paused by a usage limit.                                                                 | **[web]** |

## Open questions

1. Does `POST /request` behave as described for follow-ups, and what does it return? **[open]**
2. Exact payloads of `text_chunk` and `frame_update` during a real reply, including whether
   events for sub-agent frames arrive on the same subscription. **[open]**
3. Can a conversation be started without a project? **[open]**
4. Session lifetime and what an expired session looks like on the WebSocket. **[open]**
