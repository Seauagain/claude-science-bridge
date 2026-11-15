import type { Readable, Writable } from "node:stream";
import { createScienceCli, type ScienceCli } from "../../science-daemon/index.ts";
import { runAcpCommand } from "./acp-command.ts";
import { runDoctorCommand } from "./doctor-command.ts";

/** The process surroundings a command runs in. Passed in so that tests can supply their own. */
export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The folder the command was started in. */
  readonly cwd: string;
  /** Replaces the installed Science CLI. For tests. */
  readonly scienceCli?: ScienceCli;
}

const USAGE = `Usage: csbridge <command>

Commands:
  csbridge acp    Run as an ACP agent on standard input and output
  csbridge doctor Check the setup and say how to fix what is wrong
`;

/**
 * Runs one `csbridge` command and returns the process exit code: 0 for success, 1 for a
 * failure, 2 for wrong usage. Never writes anything but command output to standard output.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command] = argv;
  const scienceCli = io.scienceCli ?? createScienceCli({ env: io.env });

  if (command === "acp") return runAcpCommand({ ...io, scienceCli });
  if (command === "doctor") return runDoctorCommand({ ...io, scienceCli });

  io.stderr.write(command === undefined ? USAGE : `Unknown command "${command}".\n\n${USAGE}`);
  return 2;
}
