# claude-science-bridge

Use Claude Science from the agent UI you already work in, and keep your research data portable.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Anthropic.
> "Claude" and "Claude Science" are trademarks of Anthropic.

**Status: pre-alpha.** Nothing is implemented yet. This repository currently holds the design and roadmap.

## Why

Claude Science runs as a local daemon and is used through a browser tab. If you already run
your other agents (Claude Code, Codex, ...) in one desktop client, that leaves one agent
living in a separate window, and its conversations and artifacts living in a private data
directory that other agents do not know how to read.

This project aims to close both gaps:

1. **Chat with Claude Science from any ACP client.** An adapter that speaks the
   [Agent Client Protocol](https://agentclientprotocol.com) over stdio on one side and talks to
   the local Claude Science daemon on the other. Any client that can launch a local ACP agent
   (T3 Code, Zed, ...) can then host Claude Science next to its other agents.
2. **Keep your data readable without Claude Science.** A one-way exporter that turns projects,
   conversations and artifacts into plain folders, Markdown and the original files, so any
   other agent or tool can use them.

## Planned components

| Component | What it does                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter` | ACP agent over stdio. Signs in to the local daemon, creates conversations, sends prompts, translates streamed events into ACP updates, maps approval cards to ACP permission requests, supports cancel. |
| `export`  | Read-only, one-way sync from the Claude Science data directory to a plain folder tree: one folder per project, conversations as Markdown, artifacts under their original file names.                    |
| `mapping` | One local folder per Claude Science project, so a directory-based client shows the same "project → conversation" structure in its sidebar.                                                              |

## Design notes

- The daemon listens on localhost and requires a session. The adapter obtains one the same way
  the browser does: it asks the `claude-science` CLI for a single-use login link and exchanges it.
- The daemon's HTTP and WebSocket interface is internal and undocumented. It can change with any
  Claude Science update, so the adapter tracks the versions it has been tested against, warns on
  anything else, and fails with a clear error when a response does not have the expected shape.
- The exporter only ever opens the database read-only and never writes into the Claude Science
  data directory.
- Credentials, tokens and keys are never read, logged or exported.
- No Anthropic prompts, skills or other bundled assets are redistributed here.

## Checking the setup

`csbridge doctor` checks the whole setup in one go and prints one line per check: the Science
CLI can be found, the daemon is running, its version is one this release was tested with, a login
works, and whether the current folder is linked to a project. A failed check says what to do
next and makes the exit code non-zero; a warning does not.

```
$ csbridge doctor
ok    Science CLI: found
FAIL  Daemon: Claude Science is not running. Start it with `claude-science serve` and try again.
FAIL  Daemon version: not checked, because the "Daemon" check failed. Fix that first.
FAIL  Login: not checked, because the "Daemon" check failed. Fix that first.
warn  Project link: /work/folding is not linked to a project. Run "csbridge link --project <name>" in the folder you want to open sessions in.
```

`csbridge acp` reports the same problems to the ACP client when a session is opened. A daemon
version that was not tested only produces a warning on standard error.

The `claude-science` executable is looked for in this order: the `--claude-science-bin <path>`
option, the `CLAUDE_SCIENCE_BIN` environment variable, `PATH`, and `bin/` in the default Claude
Science data folder.

## When the login or the connection is lost

`csbridge acp` is meant to stay up for as long as the client does, so it looks after its
connection to Claude Science by itself:

- When Claude Science stops accepting the login, the adapter logs in again and repeats the
  request. You see nothing of it.
- The event connection is pinged. When it drops, or stops answering, the adapter opens a new one,
  waiting a little longer after each failed attempt. A reply that was being streamed goes on:
  text that was sent in the meantime is fetched from the conversation, once, and may arrive only
  when the reply is finished.
- When Claude Science stays away for more than a minute, running replies end with an error that
  says so. The adapter keeps running: once Claude Science is back, the next prompt in the same
  session works again, even when it now listens on another port.

An error that says the login could not be renewed points at the setup: run `csbridge doctor`.

## Roadmap

- [ ] Minimal adapter: new conversation, plain-text streaming replies
- [ ] Document the streamed event format the adapter depends on
- [ ] Tool calls, thinking and sub-agent activity in ACP updates
- [ ] Approval cards as ACP permission requests
- [ ] Exporter: projects, conversations, artifacts
- [ ] Resume existing conversations from the client
- [ ] Setup guide for T3 Code and Zed

## License

To be decided before the first public release.
