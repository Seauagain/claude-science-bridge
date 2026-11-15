import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpServer } from "@agentclientprotocol/sdk";

/** The MCP server through which T3 Code lets an agent act on the thread it runs in. */
const THREAD_TOOLS_SERVER = "t3-code";

/** How long the client's tool server gets to settle the thread. */
const TIME_LIMIT_MS = 10_000;

/**
 * Asks the client to settle the thread this session runs in, so that a conversation that was
 * only brought in does not show up as work that has just finished.
 *
 * Works in T3 Code, which hands every session an MCP server for this. In any other client, and
 * whenever the request does not go through, nothing happens: the thread is merely left where the
 * client put it. The server's environment carries the client's own authorization, which is
 * passed on to the server and to nothing else.
 */
export async function settleClientThread(servers: readonly McpServer[]): Promise<void> {
  for (const server of servers) {
    if ("command" in server && server.name === THREAD_TOOLS_SERVER) {
      await callTool(server, "t3_thread_organize", { action: "settle" }).catch(() => {});
      return;
    }
  }
}

/** Starts a stdio MCP server, calls one of its tools, and stops it again. */
function callTool(
  server: Extract<McpServer, { command: string }>,
  tool: string,
  toolArguments: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, {
      env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve();
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
      let message: { id?: unknown; error?: unknown };
      try {
        message = JSON.parse(line) as { id?: unknown; error?: unknown };
      } catch {
        return;
      }
      if (message.error !== undefined) return finish(new Error("the tool server refused"));
      if (message.id === 1) {
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/call", params: { name: tool, arguments: toolArguments } });
      } else if (message.id === 2) {
        finish();
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
