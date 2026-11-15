import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ScienceDaemonError } from "./errors.ts";
import type { ScienceCli } from "./science-cli.ts";

const execFileAsync = promisify(execFile);

const PROGRAM = "claude-science";

/** Where {@link createScienceCli} looks for the installed program. */
export interface ScienceCliOptions {
  /** Path of the executable as given on the command line. Wins over every other place. */
  readonly executable?: string;
  /** The environment variables to read `CLAUDE_SCIENCE_BIN` and `PATH` from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's home folder, which holds the default data folder. Defaults to the real one. */
  readonly homeFolder?: string;
  /** How long one run of the program may take, in milliseconds. Default: 15 000. */
  readonly timeoutMs?: number;
}

/**
 * The Science CLI as installed on this machine. Each call looks for the program again, in this
 * order: `options.executable`, the `CLAUDE_SCIENCE_BIN` environment variable, `PATH`, and
 * `bin/` in the default data folder. A place that is named explicitly (the first two) is not
 * skipped when nothing is installed there: that fails, naming the path.
 *
 * The returned function rejects with a `science-cli-failed` {@link ScienceDaemonError} when the
 * program cannot be found, and with the underlying error when it cannot be run, fails, or is
 * stopped because it ran longer than `options.timeoutMs`.
 */
export function createScienceCli(options: ScienceCliOptions): ScienceCli {
  return async (args) => {
    const executable = await findExecutable(options);
    const { stdout } = await execFileAsync(executable, [...args], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15_000,
    });
    return stdout;
  };
}

async function findExecutable(options: ScienceCliOptions): Promise<string> {
  if (options.executable !== undefined) {
    return namedExecutable(
      options.executable,
      "the path given on the command line. Correct it, or leave the option out to use " +
        "CLAUDE_SCIENCE_BIN or your PATH.",
    );
  }
  const fromEnvironment = options.env.CLAUDE_SCIENCE_BIN;
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    return namedExecutable(
      fromEnvironment,
      "the path in CLAUDE_SCIENCE_BIN. Correct it, or unset CLAUDE_SCIENCE_BIN to search your PATH.",
    );
  }

  const pathFolders = (options.env.PATH ?? "").split(delimiter).filter((folder) => folder !== "");
  const defaultFolder = join(options.homeFolder ?? homedir(), ".claude-science", "bin");
  for (const folder of [...pathFolders, defaultFolder]) {
    const candidate = resolve(folder, PROGRAM);
    if (await isExecutableFile(candidate)) return candidate;
  }
  throw new ScienceDaemonError(
    "science-cli-failed",
    `Could not find the Science CLI (${PROGRAM}) on your PATH or in ${defaultFolder}. ` +
      `Install Claude Science, or set CLAUDE_SCIENCE_BIN to the path of the ${PROGRAM} executable.`,
  );
}

/**
 * Returns the absolute form of a path the user named, or fails when nothing can be run there.
 * `originAndAdvice` finishes the sentence "No Science CLI can be run at <path>, ...".
 */
async function namedExecutable(path: string, originAndAdvice: string): Promise<string> {
  const executable = resolve(path);
  if (await isExecutableFile(executable)) return executable;
  throw new ScienceDaemonError(
    "science-cli-failed",
    `No Science CLI can be run at ${executable}, ${originAndAdvice}`,
  );
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    // Missing, not permitted or not a file: for the lookup they all mean "not installed here".
    return false;
  }
}
