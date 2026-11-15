import type { Writable } from "node:stream";

/** A running `csbridge acp`, as `startCli` returns it. */
interface RunningAdapter {
  readonly stdin: Writable;
  readonly output: { readonly stdout: string };
}

/** A minimal ACP client on the adapter's standard input and output. */
export function acpClient(adapter: RunningAdapter) {
  let lastId = 0;

  /** Every complete protocol message the adapter has written so far. */
  const received = (): Record<string, unknown>[] => {
    const { stdout } = adapter.output;
    return stdout
      .slice(0, stdout.lastIndexOf("\n") + 1)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  };

  /** Sends one request and returns its result. Rejects when the adapter answers with an error. */
  const request = async (method: string, params: unknown): Promise<unknown> => {
    lastId += 1;
    const id = lastId;
    adapter.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

    for (let attempt = 0; attempt < 400; attempt++) {
      const answer = received().find((message) => message.id === id);
      if (answer?.error !== undefined) throw new Error(JSON.stringify(answer.error));
      if (answer !== undefined) return answer.result;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for the answer to ${method}`);
  };

  return {
    async initialize(): Promise<void> {
      await request("initialize", { protocolVersion: 1 });
    },
    /** Opens a session in `folder` and returns its identifier. */
    async openSession(folder: string): Promise<string> {
      const result = await request("session/new", { cwd: folder, mcpServers: [] });
      if (typeof result === "object" && result !== null && "sessionId" in result) {
        return String(result.sessionId);
      }
      throw new Error(`session/new answered ${JSON.stringify(result)}`);
    },
    /** Sends one prompt and waits for the turn to end. */
    async prompt(sessionId: string, text: string): Promise<void> {
      await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    },
  };
}
