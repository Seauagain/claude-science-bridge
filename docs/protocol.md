# Claude Science daemon protocol notes

Everything this project knows about the local Claude Science daemon's interface lives here and
in `src/packages/science-daemon`. The interface is internal and undocumented: treat every
statement below as an observation about one version, not a contract.

- Observed version: **0.1.53** (macOS arm64), 2026-11-15.
- The in-repo fake daemon (`science-daemon/testing.ts`) implements exactly what this file says.
  When real behaviour differs, fix this file and the fake first, then the code.

## How each fact was established

| Mark       | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| **[live]** | Observed against the real daemon, including real turns in a scratch project. |
| **[web]**  | Read from the daemon's bundled web client code. Not exercised by us.         |
| **[open]** | Unknown.                                                                     |

## Discovery

- `claude-science status` prints JSON and always exits 0. Fields used: `running` (boolean),
  `version` (string), `port` (number). **[live]**
- The daemon listens on loopback. `GET /health` answers 200 without a login; every `/api/*`
  route answers 401 without one. **[live]**

## Login

1. `claude-science url` prints a single-use login link on stdout, valid for about three minutes:
   `http://localhost:<port>/?nonce=<hex>`. **[live]**
2. `GET` that link returns an HTML confirmation page (200) and sets the `operon_csrf` cookie.
   **[live]**
3. `POST /api/auth/nonce` with `content-type: application/x-www-form-urlencoded`, an `origin`
   header, and body `nonce=<hex>&dest=/` sets the `operon_auth` cookie (200). **[live]**
4. Login lifetime is unknown. A 401 means the login is gone: log in again. **[open]**

## Requests

- Send both cookies on every request. **[live]**
- Writes (`POST`, `PUT`, `PATCH`, `DELETE`) also need `content-type: application/json`, the header
  `x-operon-csrf: <operon_csrf cookie value>`, and an `origin` header of the daemon's own origin
  (`http://localhost:<port>`). **[live]**
- A 403 whose JSON body has `code: "csrf_stale"` means the CSRF cookie must be refreshed
  (`GET /api/csrf`), then the write retried once. **[web]**
- Error bodies carry a human-readable string in `detail` (also seen in the web client: `error`,
  `message`). **[live]**

## REST endpoints used

All paths are under `/api`.

| Call                                                   | Request and response                                                                                                                                                                                                      | Status     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `GET /me`                                              | → `{ user_id, email, provider, auth_mode, ... }`                                                                                                                                                                          | **[live]** |
| `GET /projects`                                        | → `{ projects: [{ project_id, name, description, conversation_count, archived_at, updated_at, ... }], total }`                                                                                                            | **[live]** |
| `POST /projects`                                       | `{ name, description? }` → 201 with the project                                                                                                                                                                           | **[live]** |
| `GET /models`                                          | → `{ models: { anthropic: [{ id, name, description, effort, ... }] }, default_model_id, default_effort, ... }`                                                                                                            | **[live]** |
| `GET /frames?root_only=true&project_id=<id>&limit=<n>` | → array of frames, newest first                                                                                                                                                                                           | **[live]** |
| `GET /frames/<id>?shallow=true`                        | → one frame                                                                                                                                                                                                               | **[live]** |
| `GET /frames/<id>/messages?from=<n>&limit=<n>`         | → `{ frame_id, from, total, messages: [{ role, content: [blocks], _uuid, _ts }] }`                                                                                                                                        | **[live]** |
| `POST /projects/<project_id>/request`                  | `{ input_data: { request: <text> }, model?, effort? }` → `{ root_frame_id, frame_id, status: "accepted" }`. Starts a new conversation in the project and its first turn.                                                  | **[live]** |
| `POST /request`                                        | `{ target_agent, root_frame_id, frame_id, plan_mode: false, intent_id, input_data: { request: <text> } }` → `{ root_frame_id, frame_id, status }`. Sends a further message to an existing conversation and starts a turn. | **[live]** |
| `POST /frames/<root_id>/cancel`                        | no body → `{ root_frame_id, cancelled_frames: [ids] }`                                                                                                                                                                    | **[live]** |
| `POST /frames/<id>/resolve-input`                      | `{ responses }`. Answers pending input or approval requests.                                                                                                                                                              | **[web]**  |

Notes on `POST /request`, all **[live]**:

- `target_agent` is required (400 `Invalid arguments: body.target_agent: Required` without it).
  Use the conversation frame's `agent_name`.
- `intent_id` is a fresh UUID per message.
- `status` is `"accepted"` for an idle conversation and `"message_queued"` when the conversation
  was cancelled; the turn runs either way.
- The narrower `POST /frames/<id>/message` works on a completed conversation but answers 409 on a
  cancelled one (`... is cancelled — resume it from its parent before sending a message`). Do not
  use it.

A **frame** has, among others: `id`, `root_frame_id`, `parent_frame_id` (null for a conversation),
`project_id`, `name`, `agent_name`, `status`, `conversation_type` (`"agent"` for conversations the
user sees), `created_at`, `updated_at`, `output_data`. **[live]**

`output_data.response` is not a reliable source for the reply of the turn that just ended: it was
observed to still hold the previous turn's text. Take reply text from `text_chunk` events, or from
the last assistant message of `GET /frames/<id>/messages`. **[live]**

Frame `status` values: `processing`, `completed`, `failed`, `success`, `replaced`, `cancelled`,
`awaiting_plan_approval`, `awaiting_user_response`. `processing`, `completed` and `cancelled` are
**[live]**; the rest are **[web]**. The web client treats `completed`, `failed`, `cancelled`,
`success` and `replaced` as terminal, and the two `awaiting_*` values as settled but waiting for
the user. A `processing` frame whose `has_pending_input` is true is waiting for an approval; the
requests are in `pending_input_requests`.

## WebSocket

- URL: `ws://<host>:<port>/api/ws?user_id=<user_id from /me>`. **[live]**
- The handshake needs the cookies, an `origin` header, and the subprotocol
  `operon-csrf.<operon_csrf cookie value>`, which the server echoes back. **[live]**
- Messages are JSON objects with a `type` field, in both directions. **[live]**
- Heartbeat: the client sends `{"type":"ping"}`; the server answers `{"type":"pong"}`. The web
  client pings every 25 s and reconnects when no `pong` arrives within 10 s. **[live]**
- The web client sends `{"type":"view_session","root_frame_id":<id>}` for the conversation on
  screen and `{"type":"unview_session","root_frame_id":<id>}` when leaving it. **[live]**
- **One socket carries events for all of the user's conversations**, viewed or not, including
  ones driven from the browser at the same time. Always filter by `root_frame_id`. **[live]**
- The server also pushes unrelated events (`environment_status`, `kernel_stats`, ...). Unknown
  event types must be ignored. **[live]**

### Events used

| `type`                 | Fields                                                                                                                                                                | Meaning                                                                                                                        | Status     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `frame_update`         | `root_frame_id`, `frame_id`, `status`, `agent_name`, `name`, `has_pending_input?`, `pending_input_requests?`, ...                                                     | A frame changed. Sent often, also for metadata-only changes.                                                                   | **[live]** |
| `text_chunk`           | `root_frame_id`, `frame_id`, `block_type` (`"text"` or `"thinking"`), `chunk`                                                                                         | Next piece of the reply or of the reasoning. Chunks are coarse (often a whole short reply) and `chunk` may be an empty string. | **[live]** |
| `text_reset`           | `root_frame_id`, `frame_id`                                                                                                                                           | Discard text streamed so far for this frame; the reply restarts.                                                               | **[web]**  |
| `frame_activity`       | `root_frame_id`, `frame_id`, `phase` (`llm_call`, `tool_stream`, `tool_exec`, `llm_retry`, `verifying`, `usage_limit_paused`), `tool_name?`, `tool_id?`, `iteration?` | What the agent is doing right now.                                                                                             | **[live]** |
| `frame_messages_delta` | `root_frame_id`, `frame_id`, `base_idx`, `appended` (messages or null)                                                                                                | Messages were appended to the transcript.                                                                                      | **[live]** |
| `tool_stdout_chunk`    | `root_frame_id`, ...                                                                                                                                                  | Output of a running tool.                                                                                                      | **[web]**  |
| `rate_limit_notice`    | `root_frame_id`, ...                                                                                                                                                  | The reply is paused by a usage limit.                                                                                          | **[web]**  |

### Turn lifecycle

Observed order for one turn of a conversation whose frame id is `R`, all **[live]**:

1. The client sends the message (`POST /projects/<id>/request` or `POST /request`).
2. `frame_update` for `R` with `status: "processing"`. **This can arrive before the HTTP response
   to step 1**, so start listening before sending.
3. `frame_activity` with `phase: "llm_call"`, then `text_chunk` events for `R`.
4. `frame_messages_delta` events as messages are committed.
5. `frame_update` for `R` with a terminal status (`completed`, `cancelled`, ...).

Rules that follow from what was observed:

- **A terminal `frame_update` ends the turn only after a `processing` one was seen for that turn.**
  The daemon re-sends the previous turn's terminal status (for example when it fills in a status
  description), and such a late duplicate can arrive just before the next turn's `processing`.
- For a new conversation the frame id is only known from the HTTP response, while its first
  `frame_update` may already have arrived. Buffer events until the id is known.
- After `POST /frames/<R>/cancel` the turn ends with `status: "cancelled"`. The conversation
  then accepts further messages through `POST /request`.
- Events of sub-agent frames are expected to carry the conversation's `root_frame_id` with their
  own `frame_id`. **[web]**

## Open questions

1. Can a conversation be started without a project? **[open]**
2. Login lifetime, and what an expired login looks like on the WebSocket. **[open]**
3. Exact shape of `pending_input_requests` and of the `responses` that answer them. **[open]**
4. The type of a project's `archived_at`, and whether `GET /projects` returns every project in one
   response (`total` hints at paging). Until this is observed, the code treats a project as
   archived when `archived_at` is anything but null or absent, and reads only the one response;
   the fake daemon sends null for a project in use and a timestamp string for an archived one.
   **[open]**
