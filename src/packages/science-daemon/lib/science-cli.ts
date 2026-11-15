import { ScienceDaemonError } from "./errors.ts";

/**
 * Runs the Science CLI (`claude-science`) with the given arguments and returns its standard
 * output. This is the seam to the installed program: tests pass a stand-in.
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
      `Could not run "claude-science ${args.join(" ")}". Is Claude Science installed? ` +
        "Set CLAUDE_SCIENCE_BIN to the claude-science executable if it is not on your PATH.",
      { cause },
    );
  }
}
