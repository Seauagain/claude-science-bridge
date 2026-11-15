# Glossary

Use these terms exactly, in code, tests, tickets and docs.

**Daemon**: the local Claude Science background program started by `claude-science serve`. It
serves HTTP and WebSocket on loopback. _Avoid_: server, backend.

**Science CLI**: the `claude-science` executable. The adapter runs it to find the daemon and to
obtain a login link.

**Project**: a Claude Science project. Owns conversations and artifacts.

**Conversation**: one thread of messages between the user and Claude Science inside a project.
On the wire it is a root frame. _Avoid_: chat, thread (a thread is the ACP client's word).

**Frame**: the daemon's unit of agent execution. A conversation is a root frame; work delegated to
a sub-agent runs in a child frame.

**Turn**: one user message and everything the daemon does in response, up to the point where it
finishes, fails, is cancelled, or waits for the user.

**Turn event**: one thing that happened during a turn, as reported by the `science-daemon`
package: reply text, reasoning text, activity, or the end of the turn.

**Session**: the ACP client's handle on a conversation. One session maps to at most one
conversation. _Avoid_: using "session" for the login.

**Login**: the cookie pair the daemon issues in exchange for a login link. Lives in memory only.

**Login link**: the single-use URL printed by `claude-science url`.

**Project link**: the marker file `.claude-science/project.json` that ties a local folder to a
project. A folder is **linked** when it or one of its ancestors holds one.

**Adapter**: this program in its role as an ACP agent, `csbridge acp`.

**Fake daemon**: the in-repo stand-in for the daemon used by tests. It implements
`docs/protocol.md`.
