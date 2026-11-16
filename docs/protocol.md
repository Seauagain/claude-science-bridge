# Claude Science daemon protocol notes

Everything this project knows about the local Claude Science daemon's interface lives here and
in `src/packages/science-daemon`. The interface is internal and undocumented: treat every
statement below as an observation about one version, not a contract.

- Observed version: **0.1.53** (macOS arm64), 2026-11-15. "Attachments" was observed on
  **0.1.72** (Linux x64), 2026-11-16.
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
| `POST /frames/<id>/resolve-input`                      | `{ responses: [...] }` → `{ root_frame_id, frame_id, status, race_lost_refusals, remaining_tool_ids }`. Answers input requests. See "Input requests".                                                                     | **[live]** |
| `POST /projects/<project_id>/attachments`              | `multipart/form-data` with the file in the field `file` → `{ id, version_id, filename, content_type, size_bytes, root_frame_id, created_at, file_path }`. See "Attachments".                                              | **[live]** |

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
the user. `awaiting_user_response` is **[live]** for a turn that stopped to ask: see "Input
requests".

## Input requests

What the daemon asks the user before a turn can go on: an approval, such as access to a folder
on the user's computer, or a question.

- A turn that stops to ask goes to status `awaiting_user_response`. The `frame_update` event
  that says so carries the requests in `pending_input_requests`, and `has_pending_input: true`;
  the daemon sends that event twice. Over HTTP the requests are in the frame's
  `output_data.pending_input_requests`, where they show up to a quarter of a second after the
  event. **[live]**
- A request for folder access, observed: `{ kind: "host", target: <path>, requested_mode: "ro" |
  "rw", requestId, frameId, rootFrameId, projectId, tool_id, createdAt, mode: "parked" }`. It
  follows a `request_host_access` tool use by the assistant, whose tool result comes at once.
  For a request of the conversation's own turn `frameId` is the conversation. **[live]**
- While a request is pending, `POST /request` answers 400 with `detail: "Please answer the
  pending question(s) before sending a new message."`. **[live]**
- `POST /frames/<frameId>/resolve-input` with `{ responses: [...] }` answers requests. A
  response is `{ requestId, tool_id, approved, action }` plus what its kind takes:
  - deny: `approved: false, action: "deny"`. **[live]**
  - allow folder access: `approved: true, action: "allow", mode: "ro" | "rw", scope: "always"`.
    The daemon then lists the folder under `GET /preferences/host-grants`. **[live]**
  - allow anything else: `approved: true, action: "allow"`, with `scope: "conversation" |
    "project" | "always"` to have it remembered and no `scope` for this once. **[web]**
  - a question (`kind: "ask"`, with `questions: [{ question, header, options: [{ label,
    description }], multi_select }]`): `approved: true, action: "answer", answers: { <question>:
    <label> }`, or `approved: false, action: "cancel"` to skip it. The web client shows the
    first question only, sends several picked labels joined with ", " and sends text the user
    typed as it is. **[web]**
- The answer to `resolve-input` is `{ root_frame_id, frame_id, status: "accepted",
  race_lost_refusals: [], remaining_tool_ids: [] }`. The turn then carries on by itself: the
  frame is `processing` again at once and ends as any turn does. Answering requests that are
  no longer pending gives `status: "already_resolved"` with their `tool_id`s in
  `race_lost_refusals`. **[live]** Answering some of several gives `status: "partial"` with the
  rest in `remaining_tool_ids`. **[web]**
- The kinds the web client knows, with the scopes it offers for each and the one it suggests:
  `network` and `host` (always), `host_delete` and `artifact_delete` (once, conversation),
  `mcp_tool` and `customize_mutation` (once, conversation, project, always; suggests project),
  `local_exec`, `remote_read`, `credential_access` and `byoc_kernel` (the same four; suggests
  conversation), `remote_exec`, `byoc_submit` and `infer_submit` (the same four; suggests
  once), `skill_license` (project, always), and without scopes `managed_endpoint_register`,
  `set_goal` and `usage_checkpoint`. The kinds `credential_request`, `ssh_password`,
  `provider_discovery` and `contact_email` take text the user types. **[web]**
- The web client sends the answers to the frame that holds the list, which for a sub-agent's
  request is the sub-agent's frame, and counts a list only on a frame whose status is
  `awaiting_user_response` or `processing`: a frame's `output_data` can hold what a turn that
  ended left behind. **[web]**
- Not observed: a request raised while the frame stays `processing` (`mode` other than
  `"parked"`), a request of a sub-agent frame, and what a cancel does to a turn that stopped
  to ask. The fake daemon raises parked requests only and drops them with a cancelled turn.
  **[open]**

## Attachments

A file the user sends along with a message. The daemon keeps it with the project.

- **Upload.** `POST /projects/<project_id>/attachments` is a write like any other, but its body
  is `multipart/form-data` with the file in the field `file`, so it carries no JSON content type.
  It answers 200 with `{ id, version_id, filename, content_type, size_bytes, root_frame_id,
  created_at, file_path }`; `root_frame_id` is the project's `uploads` frame. A part without a
  media type of its own (`application/octet-stream`) gets the one that goes with the file's
  name. An empty file is refused: 400, `detail: "Cannot upload empty file"`. **[live]**
- The web client sends a file above a size limit in pieces instead (`POST
  /artifacts/upload/init`, `/artifacts/upload/chunk`, `/artifacts/upload/finalize`) and takes a
  413 for "too large for this server". **[web]** Its limit for a single request is 45 MiB unless
  the daemon's page says otherwise; a single request of 50 MiB was accepted. **[live]** The
  adapter sends every file in one request and reports the daemon's refusal.
- **Reference.** A message names its attachments in front of its text: one line that holds, for
  each attachment, the JSON `{"type":"attachment","id":<id>,"version_id":<version_id>,
  "filename":<filename>,"artifact_ref":"{{artifact:<version_id>}}","content_type":<content_type>,
  "size_bytes":<size_bytes>}` with its keys in this order, the references separated by a space,
  then a line break and the text. A message can be references only. This is what the web
  client's composer sends. **[web]** for the format, **[live]** for a message sent this way to
  `POST /projects/<id>/request`: the model saw the image and read the text file.
- **In the transcript.** The user's message keeps the references as typed, in its first `text`
  block. The daemon adds blocks after it: for an image, a `text` block `[System] Attached file:
  <filename>` and an `image` block (`source.type: "_disk_ref"`); for any other file, a `text`
  block `[System] Attachment available: <filename>. Use read_file(version_id="...") to read it.`
  These `text` blocks carry no `_harness_notice`. **[live]** The adapter leaves them out and
  shows a reference as `[Attached: <filename>]`.
- `POST /request` takes references the same way: a further message with a new attachment was
  read by the model. **[live]**
- Not observed: an upload for a project that does not exist. **[open]**

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
- Blocks seen, all **[live]**: `text`, `thinking` (`{ thinking, signature }`; the text is
  empty for the current models), `image`, and the tool blocks of "Tool activity" below:
  `tool_use`, `tool_result`, `server_tool_use`, `web_search_tool_result`.
- The daemon adds messages of its own with `role: "user"` and `_harness_notice: true` (system
  context such as a compute snapshot or skill hints). They are not something the user typed and
  must not be shown as such. A `text` block can carry `_harness_notice: true` by itself, in a
  user message that also holds tool results: the user did not type that either. **[live]**
- Two more kinds of message have `role: "user"` and were not typed by the user, without being
  marked as harness notices: one with `_rolling_summary` (a summary that stands in for a part
  of a long transcript) and one with `_task_boundary`. Both hold a `text` block and can sit in
  the middle of a turn. **[live]**
- A message the user typed has `role: "user"` and as `content` a string or `text` blocks. One
  sent through `POST /request` has `_intent_id` beside it; the first message of a conversation
  started through `POST /projects/<id>/request` has not. **[live]** So the adapter takes a user
  message for the user's own when it is none of the daemon's (above), holds no `tool_result`
  block, and is a string or holds a `text` block that is not a harness notice.
- A message keeps its `_uuid` when the daemon sends it again. `total` counts harness notices. A
  read with `from` at or beyond the end answers 200 with no messages. Compaction removes
  nothing: it inserts a marker message (`_compact_boundary: true`, a harness notice) and leaves
  the messages at their indexes. **[live]** Whether a transcript can ever get shorter is not
  known. **[open]**
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

| `type`                  | Fields                                                                                                                                                                                             | Meaning                                                                                                                        | Status     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `frame_update`          | `root_frame_id`, `frame_id`, `status`, `agent_name`, `name`, `has_pending_input?`, `pending_input_requests?`, ...                                                                                  | A frame changed. Sent often, also for metadata-only changes.                                                                   | **[live]** |
| `text_chunk`            | `root_frame_id`, `frame_id`, `block_type` (`"text"` or `"thinking"`), `chunk`                                                                                                                      | Next piece of the reply or of the reasoning. Chunks are coarse (often a whole short reply) and `chunk` may be an empty string. | **[live]** |
| `text_reset`            | `root_frame_id`, `frame_id`                                                                                                                                                                        | Discard text streamed so far for this frame; the reply restarts.                                                               | **[web]**  |
| `frame_activity`        | `root_frame_id`, `frame_id`, `phase` (`llm_call`, `tool_stream`, `tool_exec`, `llm_retry`, `verifying`, `usage_limit_paused`), `tool_name?`, `tool_id?`, `is_server?`, `tool_count?`, `iteration?` | What the agent is doing right now. See "Tool activity".                                                                        | **[live]** |
| `frame_messages_delta`  | `root_frame_id`, `frame_id`, `base_idx`, `appended` (messages or null)                                                                                                                             | The transcript changed from index `base_idx` on. See "Tool activity".                                                          | **[live]** |
| `tool_stdout_chunk`     | `root_frame_id`, `frame_id`, `tool_use_id`, `data`                                                                                                                                                 | Output of a running code tool, as it is printed. Not used.                                                                     | **[live]** |
| `execution_cell_update` | `root_frame_id`, `frame_id`, `tool_use_id`, `phase` (`start`, `done`), ...                                                                                                                         | A code cell started or ended; `done` carries `exit_code`, `stdout`, `stderr`. Not used.                                        | **[live]** |
| `rate_limit_notice`     | `root_frame_id`, ...                                                                                                                                                                               | The reply is paused by a usage limit.                                                                                          | **[web]**  |

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
4. For each round of tool use, the events of "Tool activity", then step 3 again.
5. `frame_messages_delta` events as messages are committed.
6. `frame_update` for `R` with a terminal status (`completed`, `cancelled`, ...).

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

## Tool activity

What the daemon reports while the assistant uses tools. Observed on a passive socket during
real turns and in the transcripts of stored conversations, so **[live]** unless marked.

- **Blocks.** A tool use is a block of an assistant message: `{ type: "tool_use", id, name,
  input }`. `input` holds the tool's arguments and, for nearly every use, `human_description`:
  what the tool is doing, in words for the user, typically 30 to 45 characters. Its result is
  a block of the user message that follows: `{ type: "tool_result", tool_use_id, content,
  is_error? }`, where `content` is a string, mostly JSON. The web client's schema also allows
  an array of `{ type, text }`. **[web]**
- **Several at once.** One assistant message can hold text and then several `tool_use` blocks.
  All their results are in the one user message that follows, not always in the same order:
  match by `tool_use_id`.
- **Server tools.** `web_search` runs on the model's side: `{ type: "server_tool_use", id,
  name, input: { query } }`, with no `human_description`. Its result is in the same assistant
  message: `{ type: "web_search_tool_result", tool_use_id, content }`, where `content` is an
  array of `{ type: "web_search_result", title, url, ... }` or an error, `{ type:
  "web_search_tool_result_error", error_code }`.
- **Result shapes.** Code tools (`python`, `bash`, `repl`, ...) answer `{ stdout, stderr,
  exit_code, ... }`. A tool that could not run answers `{ error }`. Others answer JSON of their
  own or plain text. A code tool sent to the background answers `{ status: "running", exec_id,
  message }` at once.
- **Failure.** The web client shows a tool use as failed when `is_error` is true, when the
  content is JSON `{ error }` without `stdout` or `stderr`, when a code tool's `exit_code` is
  not 0, or when a server tool's content has a `type` that ends in `_error`. **[web]** `is_error`
  is absent on most results, also on some that failed by these rules.
- **Events of one round**, in order, for a conversation `R`:
  1. `frame_activity` with `phase: "tool_stream"`, `tool_name` and `tool_id`, once for each
     tool use, while the model writes it. `tool_id` is the `id` the block will have.
  2. `frame_activity` with `phase: "tool_exec"`.
  3. `frame_messages_delta` whose `appended` holds the assistant message with the `tool_use`
     blocks. Only now are the input and the description known: between 0.2 s and several
     minutes after step 1.
  4. `frame_messages_delta` with the assistant message and an empty user message (`content:
     []`), which then fills up: a further delta whenever a tool has ended, each holding the
     user message with the results so far.
  5. `frame_activity` with `phase: "llm_call"` for the next model call.
- **A delta replaces, it does not append.** `appended` holds complete messages, and the
  transcript from index `base_idx` on is now exactly those. Deltas overlap earlier ones, and
  the same delta is often sent twice. A reader that only looks for blocks has to tell the
  ones it has seen by their `id`.
- `appended: null` tells the web client to forget the transcript and read it again over HTTP.
  **[web]** Never seen. The adapter ignores it.
- **A tool use that is named and never recorded.** On `frame_activity` with `phase:
  "llm_retry"` the web client forgets the tool uses that `tool_stream` named during the model
  call that is tried again: they will not be recorded. **[web]** Not seen. The adapter ends
  them as failed, and does the same at the end of a turn for a use that was named and never
  recorded. A use that was recorded and has no result when the turn ends is ended with the
  turn: as failed when the turn failed or was cancelled, as completed when it completed. One
  stored conversation that failed ends with such a `tool_use`. **[live]** A turn that ends to
  wait for the user leaves its tool uses open.
- **A tool sent to the background** has its result at once (`status: "running"`), so the
  adapter reports it as ended and not failed while its code runs on. The web client shows it
  as backgrounded until `_async_exec[<tool use id>].status` of the message that holds the
  result says `completed`, `errored` or `interrupted`; the adapter does not follow that.
- Not used: `tool_stdout_chunk` and `execution_cell_update` (see "Events used"), and the
  `latest_tool_block`, `message_count` and `running_executions` fields of `frame_update`.
- **Sub-agents.** A sub-agent runs in a child frame (`parent_frame_id` set, `root_frame_id` the
  conversation), started from the code of a `repl` tool use; the parent frame's
  `context_data._sdk_child_spawn_tid` maps child frame to tool use. Hidden child frames
  (`is_hidden: true`, `agent_name: "REVIEWER"`) check the work and are no sub-agents to the
  user. Which events the daemon sends for a child frame is not known: `frame_activity` and
  `text_chunk` were seen for a hidden one, nothing else. **[open]** The adapter shows the
  tool use that starts sub-agents like any other and nothing of what they do.

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
    commits reply text when the turn ends, or with the tool uses that follow it, so text missed
    in a gap arrives at the end of the turn.
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

  Tool activity does not depend on streamed events in the same way. Every read of the transcript
  also yields the tool uses and results of the messages since the user's last one, and a
  `frame_messages_delta` carries complete messages, so deltas are used after a gap as before it.
  Reasoning text is passed on after a gap as well: its pieces continue nothing that was
  delivered, and what was streamed during the gap is lost.

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
3. Input requests other than folder access, which is the only kind exercised: the fields of
   each kind, requests raised while the frame stays `processing`, requests of sub-agent frames,
   and what a cancel does to a turn that stopped to ask. See "Input requests". **[open]**
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
8. When a streamed message enters the transcript, and how the text of a turn with several
   assistant messages relates to its `text_chunk` events. See "Recovery". **[open]**
9. What the daemon answers to `POST /request` for a conversation whose turn is still `processing`.
   This can happen after a cancel that was not confirmed in time or could not be delivered. The
   fake refuses it with 400. **[open]**
10. Assumptions the adapter makes about listing and loading that were not all observed: the frame
    list is a bare JSON array and `limit=1000` is accepted (both seen live for small projects);
    every listed frame has `id`, `name` and `updated_at` as non-empty strings; `GET
    /frames/<unknown id>/messages` answers 404; `POST /projects` accepts a name that is already
    taken. **[open]**
11. `model` and `effort` on messages: a new conversation takes both (`POST
    /projects/<id>/request`), and the frame then reports them. A further message through `POST
    /request` changes the model but leaves the effort as it was; `POST /frames/<id>/message`
    changed neither. **[live]** How the web client changes the effort of a running conversation,
    if it can, is unknown. **[open]**
12. Tool activity not observed: the events of a sub-agent's frame, a delta with `appended: null`,
    whether a `server_tool_use` is ever committed before its result, and a tool sent to the
    background while it runs on. Reasoning: every `text_chunk` with `block_type: "thinking"`
    seen live had an empty `chunk`, and whether a model that does send reasoning text sends it
    there is not known. A `thinking` block with `_progress_update: true` is a progress note the
    web client shows as text; the adapter does not. **[open]**
