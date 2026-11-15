# claude-science-bridge

Chat with Claude Science from the agent UI you already work in.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Anthropic.
> "Claude" and "Claude Science" are trademarks of Anthropic.

**Status: early.** The adapter works for plain-text conversations and is tested against Claude
Science 0.1.53. It relies on the Claude Science daemon's internal, undocumented interface, which
can change with any Claude Science update.

## What it does

Claude Science runs as a local daemon and is used through a browser tab. `csbridge acp` is an
[Agent Client Protocol](https://agentclientprotocol.com) agent that talks to that daemon, so any
client that can launch a local ACP agent (T3 Code, Zed, ...) can host Claude Science next to its
other agents:

- A thread in the client is a conversation in Claude Science. Replies stream in as they are
  written; further prompts continue the same conversation; a reply can be stopped.
- A local folder is linked to a Claude Science project. Threads opened in that folder, or in any
  folder below it, become conversations in that project, so the client's "project, then threads"
  sidebar mirrors "project, then conversations".

- Conversations that already exist in a project can be listed and imported as threads and
  continued. A thread keeps working after the client restarts the adapter.

The conversations stay in Claude Science: you can open them in its own UI at any time.

## Requirements

- Node.js 22 or newer.
- Claude Science installed, with its daemon running.

## Install

```sh
git clone https://github.com/Seauagain/claude-science-bridge.git
cd claude-science-bridge
pnpm install
pnpm build
```

The program is `dist/main.js`. The examples below call it `csbridge`; use
`node /path/to/claude-science-bridge/dist/main.js` in its place, or run `pnpm link --global` once
to get a `csbridge` command.

## Set up

1. Check the setup:

   ```
   $ csbridge doctor
   ok    Science CLI: found
   ok    Daemon: running at http://127.0.0.1:8765
   ok    Daemon version: 0.1.53, tested
   ok    Login: the daemon accepted a login link
   warn  Project link: /work/folding is not linked to a project. Run "csbridge link --project <name>" in the folder you want to open sessions in.
   ```

   A failed check says what to do next and makes the exit code non-zero; a warning does not.

2. Link a folder to a project:

   ```
   $ csbridge projects
   proj_58edd193e118  Protein folding
   $ cd /work/folding
   $ csbridge link --project "Protein folding"
   ```

   This writes `.csbridge/project.json` in the folder.

   Linking by hand is optional. Any folder works: the first message of a thread in a folder that is
   not linked links it to the project that has the folder's name, or to a new project of that name,
   and says so in the thread. Run `csbridge link` to choose a different project, or when several
   projects share the folder's name.

   To mirror all your projects at once, run `csbridge link --all ~/science-projects` (the folder
   must exist), then add the folders it lists as projects in your ACP client. Folder names are made
   valid on macOS, Linux and Windows; projects with the same name get their identifier appended. A
   folder that is already linked to a different project is skipped.

   In T3 Code, step 4 below does all of this for you.

3. Register the agent in your ACP client as a local command: the Node.js executable with the
   arguments `/path/to/claude-science-bridge/dist/main.js acp`. Then start a thread in any folder.

   In T3 Code this is a provider instance of the ACP kind with a local command. In its
   `settings.json` it looks like this:

   ```json
   "claudeScience": {
     "driver": "acpRegistry",
     "displayName": "Claude Science",
     "enabled": true,
     "environment": [],
     "config": {
       "source": "local",
       "commandPath": "/path/to/node",
       "commandArgs": ["/path/to/claude-science-bridge/dist/main.js", "acp"]
     }
   }
   ```

4. In T3 Code, bring in everything you already have with one command (step 3 first: the threads
   are started through the provider):

   ```
   $ mkdir ~/science-projects
   $ csbridge t3-import ~/science-projects
   CS-Protein folding: 12 conversations brought in
   CS-Climate model: nothing to bring in
   ```

   Every project gets a linked sub-folder and a T3 project named `CS-<project>`, and every
   conversation gets a thread on the conversation's own model. Each thread shows the earlier
   messages and is already settled, so the import does not fill your list of finished work. Run
   the command again whenever you like: it brings in only what is new. `--prefix` changes the
   `CS-` in front of the project names, and `--provider` names the provider instance if yours
   is not called `claudeScience`.

## Commands

| Command                                         | What it does                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `csbridge acp`                                  | Runs as an ACP agent on standard input and output. This is what the client launches.                                                                               |
| `csbridge projects`                             | Lists your Claude Science projects.                                                                                                                                |
| `csbridge link --project <id or name> [folder]` | Links a folder (default: the current one) to a project.                                                                                                            |
| `csbridge link --all <folder>`                  | Creates a sub-folder of `<folder>` for every project that is not archived, named after the project and linked to it. Run it again to add folders for new projects. |
| `csbridge t3-import <folder>`                   | T3 Code only. Links a sub-folder of `<folder>` to every project, adds each as a T3 project, and starts a settled thread for every conversation that has none.      |
| `csbridge doctor`                               | Checks the setup and says how to fix what is wrong.                                                                                                                |

| Setting                       | Meaning                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--claude-science-bin <path>` | The `claude-science` executable to use.                                                                                                                                                           |
| `CLAUDE_SCIENCE_BIN`          | The same, as an environment variable. Without either, `PATH` and then `bin/` in the default Claude Science data folder are tried.                                                                 |
| `CSBRIDGE_START_COMMAND`      | The command that starts Claude Science on this machine, shown when the daemon is not running. Set it if you start Claude Science through a launcher of your own. Default: `claude-science serve`. |
| `CSBRIDGE_STATE_DIR`          | The folder csbridge keeps its own state in: which thread belongs to which conversation, identifiers only. Default: `.csbridge` in your home folder.                                               |

## What to expect

- **Text only.** Prompts are sent as text; linked files are sent as their address. Images and
  other attachments are refused with a message.
- **Only the reply text is shown.** Reasoning, tool activity and sub-agent activity are not shown
  in the client yet. Open the conversation in Claude Science to see them.
- **Approvals happen in Claude Science.** When Claude Science asks for an approval (for example
  network access), the reply waits. Approve it in the Claude Science UI and the reply continues,
  or stop the reply from the client.
- **Model and effort come from Claude Science.** The client's pickers show the models Claude
  Science offers and the effort levels each takes. A model can be changed at any time; the effort
  is taken when a conversation starts, because Claude Science keeps it for the conversation.
- **Importing.** In T3 Code, `csbridge t3-import` brings in every project and conversation: see
  step 4 above. In any client, the conversations of the project a folder is linked to can also
  be imported by hand; in T3 Code that is "Native sessions" in the provider's settings.
- **A thread imported by hand starts out empty.** T3 Code discards the history an agent replays
  while a session is loaded. Type `/history` in the thread to see the earlier messages: what you
  typed, the replies, and tool use as one line each. Nothing is sent to Claude Science for it.
  Threads made by `csbridge t3-import` show their history from the start.

## When the login or the connection is lost

`csbridge acp` stays up for as long as the client does and looks after its connection to Claude
Science by itself:

- When Claude Science stops accepting the login, the adapter logs in again and repeats the
  request. You see nothing of it.
- The event connection is pinged. When it drops, or stops answering, the adapter opens a new one,
  waiting a little longer after each failed attempt. A reply that was being streamed goes on: text
  sent in the meantime is fetched from the conversation, once, and may arrive only when the reply
  is finished. In a reply that uses tools, text written before the last tool call can be missing
  in the client after such a gap; it is still in Claude Science.
- When Claude Science stays away for more than a minute, running replies end with an error that
  says so. The adapter keeps running: once Claude Science is back, the next prompt in the same
  session works again, even when it now listens on another port.

- Claude Science gets 30 seconds to answer any single request. When it accepts the connection and
  then says nothing, the prompt ends with an error that says so instead of waiting.

An error that says the login could not be renewed points at the setup: run `csbridge doctor`.

## Stopping a reply

Stopping a reply always ends the prompt as cancelled: when Claude Science confirms, at once when it
cannot be asked, and after 10 seconds when it took the request but did not stop. In the last two
cases the reply may still be running in Claude Science. A prompt that is stopped before its
message was sent is not sent at all.

## How it works

- The daemon listens on loopback and requires a login. The adapter obtains one the way the browser
  does: it asks the `claude-science` program for a single-use login link and exchanges it. The
  login is kept in memory only.
- The adapter talks to loopback only and makes no other network request. If you force Node.js to
  use a proxy for everything (`NODE_USE_ENV_PROXY=1`), make sure `NO_PROXY` includes `127.0.0.1`
  and `localhost`.
- It never reads or writes the Claude Science data folder. It keeps one file of its own,
  `sessions.jsonl` in its state folder, holding identifiers only.
- No Anthropic prompts, skills or other bundled assets are redistributed here.

For contributors: [docs/SPEC.md](./docs/SPEC.md) (requirements and process, in Chinese),
[docs/protocol.md](./docs/protocol.md) (what is known about the daemon's interface),
[CONTRIBUTING.md](./CONTRIBUTING.md) and [GLOSSARY.md](./GLOSSARY.md).

## Roadmap

- [x] Adapter: new conversations, streamed replies, follow-ups, cancel, recovery
- [x] `csbridge projects`, `csbridge link`, `csbridge doctor`
- [ ] Reasoning, tool activity and sub-agent activity in the client
- [ ] Approvals as permission requests in the client
- [x] Model and effort selection
- [ ] Attachments
- [x] Listing, importing and continuing existing conversations from the client
- [ ] Exporter: projects, conversations and artifacts as plain files

## License

To be decided before the first public release.
