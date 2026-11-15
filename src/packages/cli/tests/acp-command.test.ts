import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../science-daemon/testing.ts";
import { runCommand, startCli } from "./support/cli.ts";

let fake: FakeScienceDaemon;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
});

afterEach(async () => {
  await fake.close();
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error("timed out waiting for output");
}

describe("csbridge acp", () => {
  it("speaks ACP over standard input and output, and exits when the client disconnects", async () => {
    const cli = startCli(["acp"], fake);

    cli.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    await waitFor(() => cli.output.stdout.includes("\n"));
    cli.stdin.end();

    expect(await cli.exitCode).toBe(0);
    const lines = cli.output.stdout.trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({ protocolVersion: 1 }),
      }),
    ]);
  });
});

describe("csbridge with an unknown command", () => {
  it("prints usage to standard error and nothing to standard output", async () => {
    const cli = startCli(["frobnicate"], fake);

    expect(await cli.exitCode).toBe(2);
    expect(cli.output.stdout).toBe("");
    expect(cli.output.stderr).toMatch(/Unknown command "frobnicate"/);
    expect(cli.output.stderr).toMatch(/csbridge acp/);
  });
});

describe("csbridge without a command", () => {
  it("prints usage that names the setup commands", async () => {
    const result = await runCommand([], fake);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/csbridge projects/);
    expect(result.stderr).toMatch(/csbridge link --project <id or name> \[folder\]/);
  });
});
