import { PassThrough } from "node:stream";
import type { ScienceCli } from "../../../science-daemon/index.ts";
import { runCli } from "../../index.ts";

/** What a test supplies in place of the process surroundings. */
export interface CliSurroundings {
  readonly scienceCli: ScienceCli;
  /** Working folder of the command. Defaults to a path that does not exist. */
  readonly cwd?: string;
}

/** Starts one `csbridge` command on in-memory streams and collects what it prints. */
export function startCli(argv: string[], surroundings: CliSurroundings) {
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
    cwd: surroundings.cwd ?? "/csbridge-test-no-such-folder",
    scienceCli: surroundings.scienceCli,
  });
  return { stdin, output, exitCode };
}

/** Runs one `csbridge` command to its end and returns its exit code and what it printed. */
export async function runCommand(argv: string[], surroundings: CliSurroundings) {
  const cli = startCli(argv, surroundings);
  cli.stdin.end();
  return { exitCode: await cli.exitCode, ...cli.output };
}
