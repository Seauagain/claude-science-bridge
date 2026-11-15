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
