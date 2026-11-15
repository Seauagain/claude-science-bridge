import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createScienceCli, type ScienceCli } from "../../science-daemon/index.ts";
import { runAcpCommand } from "./acp-command.ts";
import { runDoctorCommand } from "./doctor-command.ts";
import { runLinkCommand } from "./link-command.ts";
import { runProjectsCommand } from "./projects-command.ts";

/** The process surroundings a command runs in. Passed in so that tests can supply their own. */
export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute path of the working folder. Relative folder arguments are resolved against it. */
  readonly cwd: string;
  /** Replaces the installed Science CLI. For tests. */
  readonly scienceCli?: ScienceCli;
}

const SCIENCE_CLI_OPTION = "--claude-science-bin";

const USAGE = `Usage: csbridge <command>

Commands:
  csbridge acp    Run as an ACP agent on standard input and output
  csbridge projects
                  List your Claude Science projects
  csbridge link --project <id or name> [folder]
                  Link a folder (default: the current one) to a project
  csbridge doctor Check the setup and say how to fix what is wrong

Options:
  ${SCIENCE_CLI_OPTION} <path>
                  The claude-science executable to use. Without it, csbridge tries the
                  CLAUDE_SCIENCE_BIN environment variable, then PATH, then the default
                  Claude Science data folder.

Environment:
  CSBRIDGE_START_COMMAND
                  The command that starts Claude Science on this machine, shown when it is
                  not running. Default: claude-science serve
`;

/**
 * Runs one `csbridge` command and returns the process exit code: 0 for success, 1 for a
 * failure, 2 for wrong usage. Never writes anything but command output to standard output.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const { executable, rest } = splitScienceCliOption(argv);
  if (executable === "") {
    io.stderr.write(
      `${SCIENCE_CLI_OPTION} needs the path of the claude-science executable.\n\n${USAGE}`,
    );
    return 2;
  }
  const [command, ...args] = rest;
  const scienceCli =
    io.scienceCli ??
    createScienceCli({
      env: io.env,
      ...(executable === undefined ? {} : { executable: resolve(io.cwd, executable) }),
    });

  if (command === "acp") return runAcpCommand({ ...io, scienceCli });
  if (command === "projects") return runProjectsCommand(args, { ...io, scienceCli });
  if (command === "link") return runLinkCommand(args, { ...io, scienceCli });
  if (command === "doctor") return runDoctorCommand({ ...io, scienceCli });

  io.stderr.write(command === undefined ? USAGE : `Unknown command "${command}".\n\n${USAGE}`);
  return 2;
}

/**
 * Takes `--claude-science-bin <path>` (or `--claude-science-bin=<path>`), which may stand
 * anywhere, out of the arguments. `executable` is an empty string when the path is missing.
 */
function splitScienceCliOption(argv: readonly string[]): { executable?: string; rest: string[] } {
  const position = argv.findIndex(
    (argument) => argument === SCIENCE_CLI_OPTION || argument.startsWith(`${SCIENCE_CLI_OPTION}=`),
  );
  const option = argv[position];
  if (option === undefined) return { rest: [...argv] };

  const joined = option !== SCIENCE_CLI_OPTION;
  const executable = joined
    ? option.slice(SCIENCE_CLI_OPTION.length + 1)
    : (argv[position + 1] ?? "");
  return {
    executable,
    rest: [...argv.slice(0, position), ...argv.slice(position + (joined ? 1 : 2))],
  };
}
