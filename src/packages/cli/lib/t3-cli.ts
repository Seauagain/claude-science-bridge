import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs the T3 Code command line (`t3`) with the given arguments and returns its standard
 * output. This is the seam to the installed program: tests pass a stand-in.
 */
export type T3Cli = (args: readonly string[]) => Promise<string>;

/** How long one `t3` command may take. Starting a thread waits for its first turn to end. */
const TIME_LIMIT_MS = 5 * 60_000;

/** What to tell a user whose machine has no T3 Code command line. */
export const T3_CLI_MISSING =
  "This command needs the T3 Code command line (t3), and it was not found. " +
  "Install T3 Code, make sure `t3` is on your PATH, then run the command again.";

/**
 * The T3 Code command line as installed on this machine: `program`, found on `PATH`. A command
 * that fails rejects with the first line the program wrote, which is where `t3` names what
 * went wrong, and with {@link T3_CLI_MISSING} when there is no such program to run.
 */
export function createT3Cli(program = "t3"): T3Cli {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync(program, [...args], {
        encoding: "utf8",
        timeout: TIME_LIMIT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      if (isMissingProgram(error)) throw new Error(T3_CLI_MISSING);
      throw new Error(firstLineWritten(error) ?? describe(error), { cause: error });
    }
  };
}

function isMissingProgram(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * The first line a failed program wrote. `t3` reports its errors on standard output, followed
 * by a stack trace; other programs use standard error.
 */
function firstLineWritten(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  for (const stream of ["stdout", "stderr"] as const) {
    const written: unknown = stream in error ? error[stream as keyof typeof error] : undefined;
    if (typeof written !== "string") continue;
    const line = written.split("\n").find((candidate) => candidate.trim() !== "");
    if (line !== undefined) return line.trim();
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
