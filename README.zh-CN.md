# claude-science-bridge

[English](./README.md) | **简体中文**

在 T3 Code、Zed 或任何支持 [Agent Client Protocol](https://agentclientprotocol.com) 的客户端里直接使用 Claude Science，和你的其他 agent 放在同一个窗口。

> 这是一个非官方项目，与 Anthropic 没有关联。“Claude”和“Claude Science”是 Anthropic 的商标。

![T3 Code 里的一个 Claude Science 对话：提问、Claude Science 用到的工具和其中一个工具运行的代码，以及回答](./docs/images/demo.png)

_T3 Code 里的 Claude Science。图中的项目和对话均为虚构。_

## 为什么需要它

Claude Science 单独开在一个浏览器标签页里。如果你平时已经在一个窗口里同时用好几个 agent，就得来回切换，Claude Science 的项目也和其他工作分在两处。

`csbridge` 把 Claude Science 带进你正在用的窗口：

- **和其他 agent 在同一处对话。** 新建线程，选择 Claude Science，直接输入。回复边写边显示，后续消息接着同一个对话。
- **项目出现在侧边栏。** 每个 Claude Science 项目对应客户端里的一个项目，项目下的对话就是一条条线程。
- **已有的对话一起带过来。** 一条命令把全部项目和对话连同历史导入 T3 Code。
- **看得到 Claude Science 在做什么。** 它用到的每个工具都显示在线程里：正在做什么、运行了哪段代码或哪条查询、返回了什么。
- **决定权在你手里。** Claude Science 需要你批准时（比如读取你电脑上的某个文件夹），问题会出现在客户端里，你的回答会传回去。

所有内容仍然保存在 Claude Science 里。每个对话都在原处，随时可以在 Claude Science 应用中打开。

## 开始之前

你需要：

- [Node.js](https://nodejs.org) 22 或更高版本。
- [pnpm](https://pnpm.io/installation)，用来安装和构建 bridge。
- 已安装并正在运行的 Claude Science。`csbridge` 适用于 Claude Science 0.1.53。

## 在 T3 Code 中上手

### 1. 安装

```sh
git clone https://github.com/Seauagain/claude-science-bridge.git
cd claude-science-bridge
pnpm install
pnpm build
npm link
```

最后一行让你可以直接使用 `csbridge` 命令。不想全局链接的话，把下文出现的 `csbridge` 换成 `node /path/to/claude-science-bridge/dist/main.js` 即可。

### 2. 检查环境

```
$ csbridge doctor
ok    Science CLI: found
ok    Daemon: running at http://127.0.0.1:8765
ok    Daemon version: 0.1.53, tested
ok    Login: the daemon accepted a login link
warn  Project link: /Users/you is not linked to a project yet. ...
```

某一行显示 `FAIL` 时，后面会说明该怎么处理，照做之后再运行一次。显示 `warn` 的行只是提示，不需要处理。最后一行说的是你运行命令时所在的文件夹，它会在后面的步骤里关联到项目。

### 3. 把 Claude Science 加入 T3 Code

打开 T3 Code 的 `settings.json`（`~/.t3/userdata/settings.json`），添加一个 provider。填入 Node.js 程序的路径（`which node` 会打印出来）和你克隆下来的文件夹路径：

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

重启 T3 Code，Claude Science 就会出现在 agent 列表里。

### 4. 导入你的项目和对话

```
$ mkdir ~/science-projects
$ csbridge t3-import ~/science-projects
CS-Protein folding: 12 conversations brought in
CS-Climate model: nothing to bring in
```

现在每个 Claude Science 项目在 T3 Code 里都是一个名为 `CS-<项目名>` 的项目，每个对话都是一条线程，带着之前的消息，并沿用原来的模型和推理强度。导入的线程已经归入“已完成”，不会挤占你正在进行的工作列表。

这条命令通过 T3 Code 自带的命令行 `t3` 工作，`t3` 需要在你的 `PATH` 里。T3 Code 把它安装在 `~/.t3/bin/t3`。

这条命令可以随时再运行，它只导入新增的内容。

### 5. 开始对话

打开任意一个 `CS-` 项目，用 Claude Science 新建线程，发送消息。对话会建在对应的 Claude Science 项目里。

## 日常使用

### 开始一个对话

在 `CS-` 项目里新建的线程，会成为对应 Claude Science 项目里的一个对话。

你也可以在其他任何文件夹里新建线程。第一条消息会把这个文件夹关联到同名的 Claude Science 项目（没有就新建一个），并在线程里告诉你。此后这个文件夹里的每条线程都进入该项目。

### 查看工作过程

Claude Science 工作时，它用到的每个工具都会作为一次工具调用显示在线程里：

- Claude Science 准备使用某个工具时，工具调用以工具名出现。
- 工具开始运行后，标题换成 Claude Science 自己对这一步的描述，比如“Fitting the dose-response curve”。点开可以看到它处理的代码、查询或文件。
- 工具结束后，调用标记为完成或失败，并附上返回的内容。对于代码，就是代码打印的输出。

Claude Science 在回复里提到的文件可以直接从线程里打开，即使它不在线程所在的文件夹里：`csbridge` 会在工具用过的文件夹里找到它，并用完整路径链接。

在 T3 Code 里，回复生成期间工具调用实时显示；回复结束后，它们折叠成答案上方的一行“Worked for ...”。点击这一行可以重新展开，点击某次调用可以查看它的输入和输出。

### 回答提问

Claude Science 请求批准或向你提问时，客户端会显示问题和 Claude Science 给出的选项。选一个，回复就继续进行。

没有回答的问题，会在你发送下一条消息时再次出现。

需要你输入内容的问题（比如密码、API 密钥、邮箱地址）在 Claude Science 应用里回答。线程会提示有问题在等待，你在那边回答之后，回复会在客户端里继续。

### 选择模型和推理强度

客户端的模型和推理强度选择器显示的是 Claude Science 提供的选项。模型可以随时更换；推理强度在对话开始时选定，之后一直沿用。

### 接着之前的对话

用 `csbridge t3-import` 导入的线程一开始就显示历史。在其他线程里，像发消息一样输入 `/history`，就能看到这个对话之前的内容：你写的消息、回复，以及用过的工具。这个命令不会向 Claude Science 发送任何内容。

### 停止回复

在客户端里点击停止。回复到此结束，对话可以继续接收你的下一条消息。

## 在其他 ACP 客户端中使用

任何能启动本地 ACP agent 的客户端都可以用，包括 Zed。把下面这条命令注册为一个 agent：

```
/path/to/node /path/to/claude-science-bridge/dist/main.js acp
```

然后在任意文件夹里新建线程。想一次为每个 Claude Science 项目建好一个文件夹：

```
$ mkdir ~/science-projects
$ csbridge link --all ~/science-projects
```

把它创建的文件夹作为项目添加到客户端里。项目里已有的对话，可以通过客户端自己的会话列表导入。

## 命令

| 命令                                            | 作用                                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| `csbridge doctor`                               | 检查环境，并说明如何解决发现的问题。                 |
| `csbridge t3-import <folder>`                   | 把全部项目和对话导入 T3 Code。                       |
| `csbridge projects`                             | 列出你的 Claude Science 项目。                       |
| `csbridge link --project <id or name> [folder]` | 把一个文件夹（默认是当前文件夹）关联到你指定的项目。 |
| `csbridge link --all <folder>`                  | 在 `<folder>` 下为每个项目创建一个已关联的子文件夹。 |
| `csbridge acp`                                  | 运行 bridge。客户端会替你启动它。                    |

`csbridge t3-import` 有两个选项：`--prefix` 修改项目名前面的 `CS-`；`--provider` 指定 T3 Code 里的 provider 名称，在你没有把它命名为 `claudeScience` 时使用。

### 设置

| 设置                          | 用途                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `--claude-science-bin <path>` | `claude-science` 程序的位置，在 `csbridge` 自己找不到它时使用。               |
| `CLAUDE_SCIENCE_BIN`          | 同上，以环境变量的形式设置。                                                  |
| `CSBRIDGE_START_COMMAND`      | 在你的机器上启动 Claude Science 的命令，Claude Science 未运行时显示在提示里。 |
| `CSBRIDGE_STATE_DIR`          | `csbridge` 记录“哪条线程对应哪个对话”的位置，默认是主目录下的 `.csbridge`。   |

## 使用须知

- **消息是纯文本。** 消息里链接的文件会以路径的形式发送。图片和其他附件暂不支持。
- **子 agent 在一次工具调用背后工作。** Claude Science 把工作交给子 agent 时，线程里显示启动它们的那次工具调用。想看每个子 agent 的具体过程，在 Claude Science 应用里打开这个对话。
- **工具结束后才显示输出。** 运行时间长的工具在结束前一直显示为进行中。
- **在 T3 Code 里给已完成的线程换模型。** T3 Code 可能提示“This model pick was not saved”。照常发送下一条消息即可：你选的模型会随消息一起生效，之后选择器恢复正常。
- **bridge 会自己保持连接。** 与 Claude Science 的连接断开时它会自动重连，回复继续进行。断开期间的工具调用和最终回答会稍晚一些到达。最后一次工具调用之前的文字，在断线之后可能不会出现在客户端里；Claude Science 应用里的对话是完整的。

## 常见问题

**有东西不工作。** 先运行 `csbridge doctor`。它会逐项检查环境，并告诉你该怎么做。

**提示“Claude Science is not running.”** 启动 Claude Science，然后重新发送消息。

**停止回复花了一些时间。** bridge 最多等待十秒让 Claude Science 确认，之后无论如何都会在客户端里结束这次回复。

**T3 Code 里看不到工具调用。** 打开 Settings，进入 Activity，把“Tool calls in chat”设为显示。

**手动导入的线程是空的。** 在线程里输入 `/history`。

**Claude Science 更新了。** 运行 `csbridge doctor`，它会告诉你当前版本是否在支持范围内；用 `git pull && pnpm install && pnpm build` 获取最新的 bridge。

**有两个项目同名。** `csbridge` 会请你选择。在那个文件夹里运行 `csbridge link --project <id>`，其中的 id 来自 `csbridge projects`。

## 你的数据

`csbridge` 完全在你的机器上运行，只和本机的 Claude Science 应用通信。它用和浏览器相同的方式登录，登录信息只保存在内存里。它在磁盘上保存两类小文件：主目录下 `.csbridge` 里的一份记录，写着哪条线程对应哪个对话；每个已关联的文件夹里的标记文件 `.csbridge/project.json`，写着项目的标识和名称。两者都不含对话内容。

## 后续计划

- 消息中的附件
- 子 agent 的工作过程，以及工具运行中的实时输出
- 把项目、对话和产物导出为普通文件

## 参与贡献

从 [CONTRIBUTING.md](./CONTRIBUTING.md) 开始。[docs/SPEC.md](./docs/SPEC.md) 介绍设计，[docs/protocol.md](./docs/protocol.md) 介绍 bridge 如何与 Claude Science 通信。

## 许可证

[MIT](./LICENSE)
