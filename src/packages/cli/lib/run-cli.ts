import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createScienceCli, type ScienceCli } from "../../science-daemon/index.ts";
import { runAcpCommand } from "./acp-command.ts";
import { runDoctorCommand } from "./doctor-command.ts";
import { runLinkCommand } from "./link-command.ts";
import { runProjectsCommand } from "./projects-command.ts";
import type { T3Cli } from "./t3-cli.ts";
import { runT3ImportCommand } from "./t3-import-command.ts";

/** The process surroundings a command runs in. Passed in so that tests can supply their own. */
export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute path of the working folder. Relative folder arguments are resolved against it. */
  readonly cwd: string;
  /**
   * Absolute path of the user's home folder. csbridge keeps its own state in `.csbridge` there
   * unless the `CSBRIDGE_STATE_DIR` environment variable names another folder.
   */
  readonly homeFolder: string;
  /** Replaces the installed Science CLI. For tests. */
  readonly scienceCli?: ScienceCli;
  /** The T3 Code command line. Absent on a machine without it, and in tests that do not need it. */
  readonly t3Cli?: T3Cli;
}

/** The surroundings of one command: those of the process, with the Science CLI to use settled. */
export type CommandIo = CliIo & { readonly scienceCli: ScienceCli };

const SCIENCE_CLI_OPTION = "--claude-science-bin";

/** The ways of asking for the usage text, as a command or as an option of any command. */
const HELP_REQUESTS: ReadonlySet<string> = new Set(["--help", "-h", "help"]);

const USAGE = `Usage: csbridge <command>

Commands:
  csbridge acp    Run as an ACP agent on standard input and output
  csbridge projects
                  List your Claude Science projects
  csbridge link --project <id or name> [folder]
                  Link a folder (default: the current one) to a project
  csbridge link --all <folder>
                  Create a linked sub-folder of <folder> for every project
  csbridge t3-import [--provider <id>] [--prefix <text>] <folder>
                  Bring every project and conversation into T3 Code: linked sub-folders
                  of <folder>, a T3 project for each, and a settled thread per
                  conversation. Run it again to bring in what is new
  csbridge doctor Check the setup and say how to fix what is wrong
  csbridge help   Print this text

Options:
  ${SCIENCE_CLI_OPTION} <path>
                  The claude-science executable to use. Without it, csbridge tries the
                  CLAUDE_SCIENCE_BIN environment variable, then PATH, then the default
                  Claude Science data folder.

Environment:
  CSBRIDGE_START_COMMAND
                  The command that starts Claude Science on this machine, shown when it is
                  not running. Default: claude-science serve
  CSBRIDGE_STATE_DIR
                  The folder csbridge keeps its own state in: which session belongs to
                  which conversation, and the figures that replies show. Default:
                  .csbridge in your home folder
  T3CODE_HOME
                  T3 Code's home folder. A file attached to a message in T3 Code is read
                  from there. Default: .t3 in your home folder
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
  if (rest.some((argument, position) => isHelpRequest(argument, position))) {
    io.stdout.write(USAGE);
    return 0;
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
  if (command === "t3-import") return runT3ImportCommand(args, { ...io, scienceCli });
  if (command === "doctor") return runDoctorCommand({ ...io, scienceCli });

  io.stderr.write(command === undefined ? USAGE : `Unknown command "${command}".\n\n${USAGE}`);
  return 2;
}

/** `help` asks for the usage only as the command; `--help` and `-h` ask for it wherever they stand. */
function isHelpRequest(argument: string, position: number): boolean {
  return HELP_REQUESTS.has(argument) && (position === 0 || argument !== "help");
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
