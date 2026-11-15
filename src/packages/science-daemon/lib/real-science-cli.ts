import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ScienceCli } from "./science-cli.ts";

const execFileAsync = promisify(execFile);

/** How {@link createScienceCli} finds the installed program. */
export interface ScienceCliOptions {
  /** Path of the `claude-science` executable. When absent, `PATH` and the default folder are tried. */
  readonly executable?: string;
}

/** The Science CLI as installed on this machine. */
export function createScienceCli(options: ScienceCliOptions = {}): ScienceCli {
  const candidates =
    options.executable === undefined
      ? ["claude-science", join(homedir(), ".claude-science", "bin", "claude-science")]
      : [options.executable];

  return async (args) => {
    let lastError: unknown;
    for (const executable of candidates) {
      try {
        const { stdout } = await execFileAsync(executable, [...args], { timeout: 15_000 });
        return stdout;
      } catch (error) {
        lastError = error;
        if (!isNotFound(error)) break;
      }
    }
    throw lastError;
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
