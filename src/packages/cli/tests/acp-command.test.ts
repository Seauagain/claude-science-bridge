import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../science-daemon/testing.ts";
import { runCli } from "../index.ts";

let fake: FakeScienceDaemon;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
});

afterEach(async () => {
  await fake.close();
});

function startCli(argv: string[]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = { stdout: "", stderr: "" };
  stdout.on("data", (chunk) => {
    output.stdout += String(chunk);
  });
  stderr.on("data", (chunk) => {
    output.stderr += String(chunk);
  });
  const exitCode = runCli(argv, {
    stdin,
    stdout,
    stderr,
    env: {},
    cwd: tmpdir(),
    scienceCli: fake.scienceCli,
  });
  return { stdin, output, exitCode };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error("timed out waiting for output");
}

describe("csbridge acp", () => {
  it("speaks ACP over standard input and output, and exits when the client disconnects", async () => {
    const cli = startCli(["acp"]);

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
    const cli = startCli(["frobnicate"]);

    expect(await cli.exitCode).toBe(2);
    expect(cli.output.stdout).toBe("");
    expect(cli.output.stderr).toMatch(/Unknown command "frobnicate"/);
    expect(cli.output.stderr).toMatch(/csbridge acp/);
  });
});
