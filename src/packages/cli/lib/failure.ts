import type { Writable } from "node:stream";
import { ProjectLinkError } from "../../project-link/index.ts";
import { ScienceDaemonError } from "../../science-daemon/index.ts";

/** A command cannot do what was asked. The message says why and what to do next. */
export class CommandError extends Error {
  override readonly name = "CommandError";
}

/**
 * Ends a command that failed for a reason the user can act on: prints the reason to standard
 * error and returns the exit code. Anything else is a bug and is thrown on, never swallowed.
 */
export function reportFailure(error: unknown, stderr: Writable): number {
  const expected =
    error instanceof CommandError ||
    error instanceof ScienceDaemonError ||
    error instanceof ProjectLinkError;
  if (!expected) throw error;
  stderr.write(`${error.message}\n`);
  return 1;
}
