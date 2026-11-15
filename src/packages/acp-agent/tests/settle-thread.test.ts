import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientContext, type McpServer, methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./support/harness.ts";

let harness: Harness;
let scratch: string;

beforeEach(async () => {
  harness = await startHarness();
  scratch = await mkdtemp(join(tmpdir(), "csbridge-client-tools-"));
});

afterEach(async () => {
  await harness.dispose();
  await rm(scratch, { recursive: true, force: true });
});

/**
 * A stand-in for the MCP server a client hands to its agents: it answers the MCP handshake and
 * writes down every tool call it receives, one JSON line each.
 */
async function clientTools(name: string) {
  const script = join(scratch, "tools.mjs");
  const calls = join(scratch, "calls.jsonl");
  await writeFile(calls, "", "utf8");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "0" } });
  } else if (message.method === "tools/call") {
    appendFileSync(process.env.CALLS, JSON.stringify(message.params) + "\\n");
    reply(message.id, { content: [{ type: "text", text: "{}" }] });
  }
});
`,
    "utf8",
  );
  const server: McpServer = {
    name,
    command: process.execPath,
    args: [script],
    env: [{ name: "CALLS", value: calls }],
  };
  return {
    server,
    async received(): Promise<unknown[]> {
      const lines = (await readFile(calls, "utf8")).split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line) as unknown);
    },
  };
}

async function prompt(context: ClientContext, sessionId: string, text: string) {
  return context.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
  });
}

async function projectWithConversation() {
  const { folder, projectId } = await harness.linkedFolder("Protein folding");
  const conversationId = harness.fake.addConversation(projectId, {
    title: "Fold of GFP",
    updatedAt: "2026-11-02T10:00:00Z",
    transcript: [{ role: "user", content: "What is the fold of GFP?" }],
  });
  return { folder, conversationId };
}

describe("a thread that opens an existing conversation, in a client that lets agents settle their thread", () => {
  it("is settled once the conversation has been opened", async () => {
    const { folder, conversationId } = await projectWithConversation();
    const tools = await clientTools("t3-code");

    await harness.withClient(async (context) => {
      const { sessionId } = await context.request(methods.agent.session.new, {
        cwd: folder,
        mcpServers: [tools.server],
      });
      return prompt(context, sessionId, `/open ${conversationId}`);
    });

    expect(await tools.received()).toEqual([
      { name: "t3_thread_organize", arguments: { action: "settle" } },
    ]);
  });

  it("is left as it is by an ordinary prompt", async () => {
    const { folder } = await projectWithConversation();
    const tools = await clientTools("t3-code");

    await harness.withClient(async (context) => {
      const { sessionId } = await context.request(methods.agent.session.new, {
        cwd: folder,
        mcpServers: [tools.server],
      });
      return prompt(context, sessionId, "What is the fold of GFP?");
    });

    expect(await tools.received()).toEqual([]);
  });
});

describe("a thread that opens an existing conversation, in a client without such a tool", () => {
  it("opens the conversation all the same, and calls no tool of another server", async () => {
    const { folder, conversationId } = await projectWithConversation();
    const tools = await clientTools("some-other-server");

    const { stopReason } = await harness.withClient(async (context) => {
      const { sessionId } = await context.request(methods.agent.session.new, {
        cwd: folder,
        mcpServers: [tools.server],
      });
      return prompt(context, sessionId, `/open ${conversationId}`);
    });

    expect(stopReason).toBe("end_turn");
    expect(await tools.received()).toEqual([]);
  });
});
