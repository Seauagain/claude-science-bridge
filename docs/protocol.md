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
- The `claude-science` executable of a default installation is `~/.claude-science/bin/claude-science`;
  `~/.claude-science` is the daemon's data folder. **[live]**
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

## Conversations and their messages

- `GET /frames?root_only=true&project_id=<id>&limit=<n>` lists a project's conversations, newest
  first. Each has `id`, `name` (the title), `created_at`, `updated_at`, `status`, `is_hidden` and
  `conversation_type`. Conversations the user sees have `conversation_type: "agent"`; a project
  also holds frames of other types (for example `"uploads"`). Whether the list is ever cut short
  below `limit`, and how to ask for the rest, is unknown. **[live]** for the fields, **[open]** for
  paging.
- `GET /frames/<id>/messages?from=<n>&limit=<n>` returns `{ frame_id, from, total, messages }`.
  A message has `role` (`user` or `assistant`) and `content`. **[live]**
- `content` is an array of blocks, or for some user messages a plain string. **[live]**
- Blocks seen: `{ type: "text", text }` **[live]**, and in conversations that used tools
  `tool_use` (`id`, `name`, `input` with a `human_description`), `tool_result`, `thinking`,
  `image`. The tool blocks were seen in stored data, not fetched by us over this call. **[web]**
- The daemon adds messages of its own with `role: "user"` and `_harness_notice: true` (system
  context such as a compute snapshot or skill hints). They are not something the user typed and
  must not be shown as such. **[live]**
- A turn that was cancelled leaves no assistant message in the transcript. **[live]** (seen once)

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

Not handled: `text_reset`. ACP cannot take back text already sent to the client, so the adapter
ignores it; after a reset the client shows the discarded text followed by the restarted reply.

Where a failed turn's reason is reported is unknown. The adapter reads `status_description` from
the `frame_update` that ends the turn (the field was seen live on `frame_update`, but never on a
failed turn) and says "no reason given" without it. **[open]**

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

## Recovery

What the adapter does when the login or the connection is lost. Nothing in this section was
observed on the real daemon: each point names the fact it builds on and the reading chosen where
there is none. The fake daemon behaves as described here.

- **Expired login.** A request answered 401 gets one new login (steps 1 to 3 of "Login") and is
  sent once more; a second 401 is an error. This builds on "a 401 means the login is gone".
  **[open]**
- **Stale CSRF token.** A write answered 403 with `code: "csrf_stale"` is followed by
  `GET /api/csrf` and sent once more. **[web]** How that response hands over the new token is not
  known: the adapter takes it from an `operon_csrf` cookie the response sets, as at login, and
  ignores the body. The fake sets the cookie and answers `{}`. **[open]**
- **Keeping the socket alive.** The adapter pings every 25 s and treats the socket as dropped
  when no `pong` arrives within 10 s, as "WebSocket" above says the web client does.
- **Reopening the socket.** A dropped socket is reopened, with a growing wait between attempts
  (1 s, doubling, at most 10 s) for 60 s. Each attempt first runs `claude-science status`, so a
  daemon that came back on another port is found. A handshake answered 401 gets one new login
  and one more handshake. The fake keeps the sockets of an expired login open and refuses new
  handshakes with 401; whether the real daemon closes such sockets, and what it answers to a
  handshake without a login, is not known. Whether a restarted daemon keeps its port and its
  logins is not known either: the fake comes back on a new port and without its logins.
  **[open]**
- **Catching up after a gap.** Events sent while the socket was down are lost, and nothing says
  whether text streamed after the gap continues what was received before it. So once the socket
  was reopened during a turn, the adapter stops using `text_chunk` events for that turn and reads
  `GET /frames/<id>?shallow=true` and then the last page of `GET /frames/<id>/messages`, right
  after reopening and again whenever a terminal `frame_update` arrives. From the last message,
  if its `role` is `assistant`, it takes the text and delivers the part not delivered yet; a
  terminal status ends the turn. This builds on "reply text can be read from the last assistant
  message" **[live]** and on these readings, all **[open]**:
  - A reply's text is the concatenation of the `text` of its content blocks of
    `type: "text"`, and equals what `text_chunk` events with `block_type: "text"` streamed.
  - A message appears in the transcript once it is complete, not while it is streamed. The fake
    commits a reply as one assistant message when the turn ends, so text missed in a gap arrives
    at the end of the turn.
  - By the time the daemon has accepted a message (the HTTP response has arrived), the user's
    message is in the transcript and the frame's status is that of the new turn, so a terminal
    status read afterwards means this turn has ended.
  - `from` is a zero-based index into the transcript and `total` its length. The adapter walks
    the pages (`limit=100`) until `from` plus the number of messages returned reaches `total`.
    The fake refuses a request without `from` and `limit`.
  - The frame returned by `GET /frames/<id>` carries the same `status_description` as a
    `frame_update` does.

  In a turn with several assistant messages (tool use), only the last one is read this way: text
  of earlier messages that was streamed during or after the gap is not delivered.

### What the adapter does when the daemon is silent

Nothing in this section was observed on the real daemon; the fake daemon invented each behaviour.

- **A daemon that does not answer.** The adapter gives every HTTP request, each login request and
  the socket handshake 30 s and treats a request that runs out of time as `unreachable`. The fake
  can stop answering while still accepting connections. Whether `claude-science status` reports a
  daemon that hangs as running is not known. **[open]**
- **Cancel without confirmation.** After `POST /frames/<R>/cancel` the adapter waits 10 s for the
  terminal `frame_update`, counted from the client's cancel, and then ends the turn as cancelled on
  its own. The fake can answer a cancel as usual and leave the turn running. Whether the real
  daemon ever does that is not known. **[open]**

## Open questions

1. Can a conversation be started without a project? **[open]**
2. Login lifetime, and what an expired login looks like on the WebSocket: whether the daemon
   closes the socket, and what it answers to a new handshake. See "Recovery" for the reading the
   adapter and the fake use. **[open]**
3. Exact shape of `pending_input_requests` and of the `responses` that answer them. **[open]**
4. What `POST /frames/<id>/cancel` answers, and whether it changes the frame's status, for a
   conversation with no running turn or for an unknown id. The adapter only cancels a turn it is
   following; the fake answers an empty `cancelled_frames` and 404 respectively and changes
   nothing. **[open]**
5. The type of a project's `archived_at`, and whether `GET /projects` returns every project in one
   response (`total` hints at paging). Until this is observed, the code treats a project as
   archived when `archived_at` is anything but null or absent, and reads only the one response;
   the fake daemon sends null for a project in use and a timestamp string for an archived one.
   **[open]**
6. What `GET /api/csrf` answers, and whether a token issued earlier stays valid. **[open]**
7. What a restarted daemon makes of a turn it was running: whether the frame stays `processing`,
   and whether the conversation then takes a further message. The adapter keeps following such a
   turn until its status changes or the user cancels. **[open]**
8. The shape of a message's content blocks, when a streamed message enters the transcript, and
   how the text of a turn with several assistant messages relates to its `text_chunk` events.
   See "Recovery". **[open]**
9. What the daemon answers to `POST /request` for a conversation whose turn is still `processing`.
   This can happen after a cancel that was not confirmed in time or could not be delivered. The
   fake refuses it with 400. **[open]**
10. Assumptions the adapter makes about listing and loading that were not all observed: the frame
    list is a bare JSON array and `limit=1000` is accepted (both seen live for small projects);
    every listed frame has `id`, `name` and `updated_at` as non-empty strings; `GET
    /frames/<unknown id>/messages` answers 404; a `tool_use` block carries `id`, `name` and
    `input.human_description`; `POST /projects` accepts a name that is already taken. **[open]**
11. `model` and `effort` on messages: a new conversation takes both (`POST
    /projects/<id>/request`), and the frame then reports them. A further message through `POST
    /request` changes the model but leaves the effort as it was; `POST /frames/<id>/message`
    changed neither. **[live]** How the web client changes the effort of a running conversation,
    if it can, is unknown. **[open]**
