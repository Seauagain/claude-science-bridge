# claude-science-bridge

**English** | [简体中文](./README.zh-CN.md)

Use Claude Science inside T3 Code, Zed, or any other client that speaks the
[Agent Client Protocol](https://agentclientprotocol.com), right next to your other agents.

> An unofficial project, not affiliated with Anthropic. "Claude" and "Claude Science" are
> trademarks of Anthropic.

![A Claude Science conversation in T3 Code: the question, the tools Claude Science used with the code one of them ran, and the answer](./docs/images/demo.png)

_Claude Science in T3 Code. The two framed labels are added to point out the Claude Science
project and model; the projects and the conversation shown are invented._

## Why

Claude Science lives in a browser tab of its own. If you already work with several agents in one
window, that means switching back and forth, and your Claude Science projects sit apart from
everything else.

`csbridge` brings Claude Science into the window you already use:

- **Chat where your other agents are.** Start a thread, pick Claude Science, and type. Replies
  stream in as they are written, and follow-up messages continue the same conversation.
- **Your projects in the sidebar.** Each Claude Science project becomes a project in your client,
  with its conversations as threads underneath.
- **Your existing conversations come along.** One command brings every project and conversation
  into T3 Code, with its history.
- **See what Claude Science is doing.** Every tool it uses appears in the thread: what it is
  doing, the code or query it ran, and what came back.
- **Stay in control.** When Claude Science needs your approval, for example to read a folder on
  your computer, the question comes up in your client and your answer goes back.

Nothing moves out of Claude Science. Every conversation is still there, and you can open it in the
Claude Science app whenever you like.

## Before you start

You need:

- [Node.js](https://nodejs.org) 22 or newer.
- [pnpm](https://pnpm.io/installation), which installs and builds the bridge.
- Claude Science installed and running. `csbridge` works with Claude Science 0.1.53.

## Get started with T3 Code

### 1. Install

```sh
git clone https://github.com/Seauagain/claude-science-bridge.git
cd claude-science-bridge
pnpm install
pnpm build
npm link
```

The last line gives you the `csbridge` command. If you prefer not to link it, write
`node /path/to/claude-science-bridge/dist/main.js` wherever this guide says `csbridge`.

### 2. Check that everything is in place

```
$ csbridge doctor
ok    Science CLI: found
ok    Daemon: running at http://127.0.0.1:8765
ok    Daemon version: 0.1.53, tested
ok    Login: the daemon accepted a login link
warn  Project link: /Users/you is not linked to a project yet. ...
```

If a line says `FAIL`, it also says what to do. Fix that and run the command again. A line that
says `warn` is a hint and needs no action. The last line is about the folder you ran the command
in, which gets its project in the steps below.

### 3. Add Claude Science to T3 Code

Open T3 Code's `settings.json` (`~/.t3/userdata/settings.json`) and add a provider. Put in the
path of your Node.js program (`which node` prints it) and the path of the folder you cloned:

```json
"providerInstances": {
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
}
```

Restart T3 Code. Claude Science now appears in the list of agents.

### 4. Bring in your projects and conversations

```
$ mkdir ~/science-projects
$ csbridge t3-import ~/science-projects
CS-Protein folding: 12 conversations brought in
CS-Climate model: nothing to bring in
```

Every Claude Science project now shows up in T3 Code as a project named `CS-<project>`, and every
conversation as a thread that shows its earlier messages and keeps its model and effort. The
threads arrive already settled, so they do not crowd your list of open work.

The command works through T3 Code's own command line, `t3`, which has to be on your `PATH`.
T3 Code installs it as `~/.t3/bin/t3`.

Run the command again whenever you like. It brings in only what is new.

### 5. Start chatting

Open one of the `CS-` projects, start a thread with Claude Science, and send a message. The
conversation is created in the matching Claude Science project.

## Using it

### Starting a conversation

A thread started in a `CS-` project becomes a conversation in that Claude Science project.

You can also start a thread in any other folder. The first message connects the folder to the
Claude Science project of the same name, creating the project if there is none, and tells you so
in the thread. From then on, every thread in that folder goes to that project.

### Watching it work

While Claude Science works, each tool it uses shows up in the thread as a tool call:

- When Claude Science reaches for a tool, the call appears under the tool's name.
- Once the tool runs, the call is titled with what it is doing, in Claude Science's own words,
  such as "Fitting the dose-response curve". Open it to see the code, query or file it works on.
- When the tool finishes, the call is marked completed or failed and holds what the tool gave
  back. For code, that is what the code printed.

A file Claude Science names in a reply opens from the thread, also when it lies outside the
thread's folder: `csbridge` finds it in the folders the tools worked in and links it by its full
path.

In T3 Code, tool calls are shown live while the reply is being written. Afterwards they fold into
a single "Worked for ..." row above the answer. Click the row to see them again, and click a call
to see its input and output.

### Answering questions

When Claude Science asks for an approval or puts a question to you, your client shows it with the
choices Claude Science offers. Pick one and the reply carries on.

If you leave a question unanswered, it comes up again with your next message.

Questions that need you to type something, such as a password, an API key or an email address,
are answered in the Claude Science app. The thread tells you when one is waiting, and the reply
continues in your client as soon as you have answered it there.

### Choosing a model and effort

The model and effort pickers of your client show what Claude Science offers. You can change the
model at any time. The effort is chosen when a conversation starts and stays with it.

### Picking up earlier conversations

Threads brought in by `csbridge t3-import` show their history from the start. In any other
thread, type `/history` like a message to see the conversation's earlier messages: what you
wrote, the replies, and the tools that were used. Nothing is sent to Claude Science for it.

### Stopping a reply

Press stop in your client. The reply ends there, and the conversation is ready for your next
message.

## Using another ACP client

Any client that can launch a local ACP agent works, Zed included. Register this command as an
agent:

```
/path/to/node /path/to/claude-science-bridge/dist/main.js acp
```

Then start a thread in any folder. To get a folder for each of your Claude Science projects in
one go:

```
$ mkdir ~/science-projects
$ csbridge link --all ~/science-projects
```

Add the folders it creates as projects in your client. Existing conversations of a project can be
imported through your client's own list of sessions for that folder.

## Commands

| Command                                         | What it does                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `csbridge doctor`                               | Checks your setup and says how to fix what is wrong.                    |
| `csbridge t3-import <folder>`                   | Brings every project and conversation into T3 Code.                     |
| `csbridge projects`                             | Lists your Claude Science projects.                                     |
| `csbridge link --project <id or name> [folder]` | Connects a folder (the current one by default) to a project you choose. |
| `csbridge link --all <folder>`                  | Creates a connected sub-folder of `<folder>` for every project.         |
| `csbridge acp`                                  | Runs the bridge. Your client starts this for you.                       |

`csbridge t3-import` takes two options: `--prefix` changes the `CS-` in front of project names,
and `--provider` names your T3 Code provider if you did not call it `claudeScience`.

### Settings

| Setting                       | What it is for                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--claude-science-bin <path>` | Where the `claude-science` program is, if `csbridge` does not find it by itself.                                   |
| `CLAUDE_SCIENCE_BIN`          | The same, as an environment variable.                                                                              |
| `CSBRIDGE_START_COMMAND`      | The command that starts Claude Science on your machine, shown in the hint when Claude Science is not running.      |
| `CSBRIDGE_STATE_DIR`          | Where `csbridge` remembers which thread belongs to which conversation. By default `.csbridge` in your home folder. |

## Good to know

- **Attachments are copied into the project.** An image or file you attach to a message is
  handed to Claude Science and kept with the conversation's project, as when you attach it in
  the Claude Science app. A file you only link in a message is sent as its path. Audio is not
  supported, and neither is a file too large for Claude Science to take in one upload.
- **Sub-agents work behind one tool call.** When Claude Science hands work to sub-agents, the
  thread shows the tool call that starts them. Open the conversation in the Claude Science app
  to follow what each sub-agent does.
- **Output appears when a tool finishes.** A long-running tool shows as in progress until then.
- **Changing the model on a finished thread in T3 Code.** T3 Code may say "This model pick was
  not saved". Send your next message anyway: the model you picked goes out with it, and the
  picker works as usual from then on.
- **The bridge keeps itself connected.** If the connection to Claude Science drops, it reconnects
  and the reply carries on. Tool calls and the final answer from the gap arrive a little late.
  Text written before the last tool call can be missing in your client after such a gap; the
  conversation in the Claude Science app has all of it.

## Troubleshooting

**Something does not work.** Run `csbridge doctor` first. It checks each part of the setup and
tells you what to do.

**"Claude Science is not running."** Start Claude Science, then send your message again.

**A reply takes long to stop.** The bridge waits up to ten seconds for Claude Science to confirm,
then ends the reply in your client either way.

**No tool calls in T3 Code.** Open Settings, Activity, and set "Tool calls in chat" to show them.

**A thread brought in by hand is empty.** Type `/history` in it.

**Claude Science was updated.** Run `csbridge doctor`. It tells you whether your version is one
the bridge supports, and `git pull && pnpm install && pnpm build` gets you the latest bridge.

**A project name is used twice.** `csbridge` asks you to choose. Run
`csbridge link --project <id>` in the folder, with an id from `csbridge projects`.

## Your data

`csbridge` runs entirely on your machine and talks only to the Claude Science app on it. It logs
in the same way the browser does and keeps that login in memory. On disk it keeps two kinds of
small files: a record in `.csbridge` in your home folder of which thread belongs to which
conversation, and a marker file `.csbridge/project.json` in each connected folder with the
project's identifier and name. Neither holds any content of a conversation.

## Coming next

- What sub-agents are doing, and the output of a tool while it runs
- Exporting projects, conversations and artifacts as plain files

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md). [docs/SPEC.md](./docs/SPEC.md) describes the
design (in Chinese), and [docs/protocol.md](./docs/protocol.md) how the bridge talks to Claude
Science.

## License

[MIT](./LICENSE)
