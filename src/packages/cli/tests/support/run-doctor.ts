import { PassThrough } from "node:stream";
import type { ScienceCli } from "../../../science-daemon/index.ts";
import { runCli } from "../../index.ts";

/** The surroundings of one `csbridge doctor` run. */
export interface DoctorRun {
  /** Arguments after `doctor`. */
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** The folder the command is started in. */
  readonly cwd: string;
  /**
   * A Science CLI stand-in. Leave it out only together with an `env` or `args` that name a
   * stand-in program, so that the program installed on this machine is never looked for.
   */
  readonly scienceCli?: ScienceCli;
}

/** Runs `csbridge doctor` to its end and returns the exit code and what it printed. */
export async function runDoctor(run: DoctorRun) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const printed = { stdout: "", stderr: "" };
  stdout.on("data", (chunk) => {
    printed.stdout += String(chunk);
  });
  stderr.on("data", (chunk) => {
    printed.stderr += String(chunk);
  });
  const exitCode = await runCli(["doctor", ...(run.args ?? [])], {
    stdin: new PassThrough(),
    stdout,
    stderr,
    env: run.env ?? {},
    cwd: run.cwd,
    // The doctor keeps no state.
    homeFolder: "/csbridge-test-no-such-home",
    ...(run.scienceCli === undefined ? {} : { scienceCli: run.scienceCli }),
  });
  return { exitCode, lines: printed.stdout.trimEnd().split("\n"), stderr: printed.stderr };
}
