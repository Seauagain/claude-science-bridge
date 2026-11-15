import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectLink } from "../../project-link/index.ts";
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

/** Opens a session in a folder linked to a project, as an ACP client would, then disconnects. */
async function openSessionThenDisconnect() {
  const folder = await mkdtemp(join(tmpdir(), "csbridge-acp-"));
  try {
    await writeProjectLink(folder, {
      projectId: fake.addProject("Protein folding"),
      name: "Protein folding",
    });
    const cli = startCli(["acp"]);
    const request = (id: number, method: string, params: unknown) =>
      cli.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

    request(1, "initialize", { protocolVersion: 1 });
    request(2, "session/new", { cwd: folder, mcpServers: [] });
    await waitFor(() => cli.output.stdout.split("\n").length > 2);
    cli.stdin.end();
    return { exitCode: await cli.exitCode, output: cli.output };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe("csbridge acp with a daemon version it was not tested with", () => {
  it("warns on standard error and keeps serving the client", async () => {
    fake.reportVersion("9.9.9");

    const { exitCode, output } = await openSessionThenDisconnect();

    expect(exitCode).toBe(0);
    expect(output.stderr).toMatch(/warning: .*9\.9\.9 has not been tested.*0\.1\.53/);
    // Standard output still carries protocol messages only, and the session was opened.
    const messages = output.stdout.trimEnd().split("\n");
    expect(messages.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: 1, result: expect.anything() }),
      expect.objectContaining({ id: 2, result: { sessionId: expect.any(String) } }),
    ]);
  });
});

describe("csbridge acp after the client has disconnected", () => {
  it("leaves no connection to the daemon open, so the process can exit", async () => {
    await openSessionThenDisconnect();

    await waitFor(() => fake.eventConnectionCount() === 0);
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
