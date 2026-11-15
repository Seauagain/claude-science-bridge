import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../science-daemon/testing.ts";
import { runCli } from "../index.ts";

let fake: FakeScienceDaemon;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
  fake.reportRunning(false);
});

afterEach(async () => {
  await fake.close();
});

/** Runs one command with the given environment while the daemon is not running. */
async function run(argv: string[], env: Record<string, string>) {
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
  stdin.end();
  await runCli(argv, { stdin, stdout, stderr, env, cwd: tmpdir(), scienceCli: fake.scienceCli });
  return output;
}

describe("the hint for starting a daemon that is not running", () => {
  it("names the plain Science CLI command by default", async () => {
    const { stderr } = await run(["projects"], {});

    expect(stderr).toMatch(/not running\. Start it with `claude-science serve` and try again/);
  });

  it("names the command from CSBRIDGE_START_COMMAND, for setups that start the daemon their own way", async () => {
    const { stderr } = await run(["projects"], { CSBRIDGE_START_COMMAND: "my-launcher start" });

    expect(stderr).toMatch(/not running\. Start it with `my-launcher start` and try again/);
    expect(stderr).not.toMatch(/claude-science serve/);
  });

  it("is the same in csbridge doctor", async () => {
    const { stdout } = await run(["doctor"], { CSBRIDGE_START_COMMAND: "my-launcher start" });

    expect(stdout).toMatch(/FAIL +Daemon: .*Start it with `my-launcher start`/);
  });
});
