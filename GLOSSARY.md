# Glossary

Use these terms exactly, in code, tests, tickets and docs.

**Daemon**: the local Claude Science background program started by `claude-science serve`. It
serves HTTP and WebSocket on loopback. _Avoid_: server, backend.

**Science CLI**: the `claude-science` executable. The adapter runs it to find the daemon and to
obtain a login link.

**Project**: a Claude Science project. Owns conversations and artifacts.

**Conversation**: one thread of messages between the user and Claude Science inside a project.
On the wire it is a root frame. _Avoid_: chat, thread (a thread is the ACP client's word).

**Attachment**: a file the user sends along with a message. The daemon keeps it with the
conversation's project, and the message names it by a **reference**. _Avoid_: upload (the act,
not the file).

**Frame**: the daemon's unit of agent execution. A conversation is a root frame; work delegated to
a sub-agent runs in a child frame.

**Turn**: one user message and everything the daemon does in response, up to the point where it
finishes, fails, is cancelled, or waits for the user.

**Turn event**: one thing that happened during a turn, as reported by the `science-daemon`
package: a piece of reply text or of reasoning, news of a tool use, input requests, or the end
of the turn with its outcome.

**Tool use**: one call of a tool by Claude Science during a turn, with the tool's name, its
**input** (the arguments), a **description** in words for the user, and in the end a **result**.
In an ACP client it shows as a **tool call**, which is the client's word. _Avoid_: tool call for
the daemon's side, tool invocation.

**Input request**: something the daemon asks the user before a turn can go on: an approval, for
example of access to a folder, or a question. It has **choices**; the user's pick is the
**answer**. Some take a **typed answer** as well: text in the user's own words, such as an email
address. _Avoid_: permission (ACP's word for one way of asking), prompt.

**Session**: the ACP client's handle on a conversation. One session maps to at most one
conversation. _Avoid_: using "session" for the login.

**Login**: the cookie pair the daemon issues in exchange for a login link. Lives in memory only.

**Login link**: the single-use URL printed by `claude-science url`.

**Project link**: the marker file `.csbridge/project.json` that ties a local folder to a
project. A folder is **linked** when it or one of its ancestors holds one.

**State folder**: where csbridge keeps its own record of which session belongs to which
conversation (`sessions.jsonl`, identifiers only). Never inside the Claude Science data folder.

**Adapter**: this program in its role as an ACP agent, `csbridge acp`.

**Fake daemon**: the in-repo stand-in for the daemon used by tests. It implements
`docs/protocol.md`.
