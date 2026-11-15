import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { ConversationSettings } from "../../science-daemon/index.ts";

/** The MCP server through which T3 Code lets an agent act on the thread it runs in. */
const THREAD_TOOLS_SERVER = "t3-code";

/** How long the client's tool server gets for one request. */
const TIME_LIMIT_MS = 10_000;

/**
 * Arranges the client's thread for a conversation that was brought into it: the thread is
 * given the conversation's model and effort to show, and is settled, so that it does not look
 * like work that has just finished.
 *
 * Works in T3 Code, which hands every session an MCP server for this and does not take a
 * session's options from the session itself. In any other client, and whenever a request does
 * not go through, nothing happens: the thread is merely left as the client made it. The
 * server's environment carries the client's own authorization, which is passed on to the
 * server and to nothing else.
 */
export async function arrangeClientThread(
  servers: readonly McpServer[],
  settings: ConversationSettings,
): Promise<void> {
  const server = servers.find(
    (each): each is ToolServer => "command" in each && each.name === THREAD_TOOLS_SERVER,
  );
  if (server === undefined) return;
  await showSettings(server, settings).catch(() => {});
  await callTool(server, "t3_thread_organize", { action: "settle" }).catch(() => {});
}

/**
 * Adds the conversation's model and effort to the thread's options. The provider and model
 * the client gave the thread stay as they are: T3 Code refuses a change of model on a thread
 * that has no session bound to it, and accepts a change of options at any time.
 */
async function showSettings(server: ToolServer, settings: ConversationSettings): Promise<void> {
  const options = [
    ...(settings.model === undefined ? [] : [{ id: "model", value: settings.model }]),
    ...(settings.effort === undefined ? [] : [{ id: "effort", value: settings.effort }]),
  ];
  if (options.length === 0) return;
  const current = threadSelection(await callTool(server, "t3_thread_configure", {}));
  if (current === undefined) return;
  await callTool(server, "t3_thread_configure", { modelSelection: { ...current, options } });
}

/** Reads the provider and model of a thread from what `t3_thread_configure` answers. */
function threadSelection(
  answer: string | undefined,
): { instanceId: string; model: string } | undefined {
  if (answer === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return undefined;
  }
  const selection = isRecord(parsed) ? parsed.modelSelection : undefined;
  if (!isRecord(selection)) return undefined;
  const { instanceId, model } = selection;
  return typeof instanceId === "string" && typeof model === "string"
    ? { instanceId, model }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type ToolServer = Extract<McpServer, { command: string }>;

/**
 * Starts a stdio MCP server, calls one of its tools, and stops it again. Resolves with the
 * text the tool answered, if it answered any.
 */
function callTool(
  server: ToolServer,
  tool: string,
  toolArguments: Record<string, unknown>,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const finish = (error?: Error, answer?: string) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(answer);
    };
    const timer = setTimeout(
      () => finish(new Error("the tool server did not answer")),
      TIME_LIMIT_MS,
    );
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

    child.once("error", finish);
    child.stdin.once("error", finish);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { id?: unknown; error?: unknown; result?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.error !== undefined) return finish(new Error("the tool server refused"));
      if (message.id === 1) {
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/call", params: { name: tool, arguments: toolArguments } });
      } else if (message.id === 2) {
        finish(undefined, answeredText(message.result));
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-science-bridge", version: "0" },
      },
    });
  });
}

/** The first piece of text in a tool's result. */
function answeredText(result: unknown): string | undefined {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  for (const piece of content) {
    if (isRecord(piece) && piece.type === "text" && typeof piece.text === "string") {
      return piece.text;
    }
  }
  return undefined;
}
