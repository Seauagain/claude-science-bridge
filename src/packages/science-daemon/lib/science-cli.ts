import { ScienceDaemonError } from "./errors.ts";
import { isRecord } from "./validate.ts";

/**
 * Runs the Science CLI (`claude-science`) with the given arguments and returns its standard
 * output. This is the seam to the installed program: tests pass a stand-in.
 *
 * A failure to run the program is reported the way Node's `child_process` reports it: `code`
 * is `"ENOENT"` for a program that is not there and the exit code for one that failed, and
 * `killed` is true for one that was stopped because it took too long.
 */
export type ScienceCli = (args: readonly string[]) => Promise<string>;

/** Runs the Science CLI, turning any failure into a `science-cli-failed` error. */
export async function runScienceCli(
  scienceCli: ScienceCli,
  args: readonly string[],
): Promise<string> {
  try {
    return await scienceCli(args);
  } catch (cause) {
    if (cause instanceof ScienceDaemonError) throw cause;
    throw new ScienceDaemonError(
      "science-cli-failed",
      describeFailure(`claude-science ${args.join(" ")}`, cause),
      { cause },
    );
  }
}

/**
 * Says what went wrong with `command` and what to do next. Only a program that is not there is
 * a reason to ask whether Claude Science is installed. The error's own message is left out: it
 * can quote what the program printed, and that may be a login link.
 */
function describeFailure(command: string, cause: unknown): string {
  const { code, killed } = isRecord(cause) ? cause : {};
  if (code === "ENOENT") {
    return (
      `Could not run "${command}": the program was not found. Is Claude Science installed? ` +
      "Set CLAUDE_SCIENCE_BIN to the claude-science executable if it is not on your PATH."
    );
  }
  if (killed === true) {
    return (
      `"${command}" did not finish in time and was stopped. ` +
      "Run it in a terminal to see what holds it up."
    );
  }
  const how = typeof code === "number" ? ` with exit code ${code}` : "";
  return `"${command}" failed${how}. Run it in a terminal to see what is wrong.`;
}
