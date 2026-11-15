import type { ScienceCli } from "../../science-daemon/index.ts";
import type { CliIo } from "./run-cli.ts";

/** What the `science-daemon` package is told about this machine's Claude Science. */
export interface DaemonSetup {
  readonly scienceCli: ScienceCli;
  readonly startCommand?: string;
}

/**
 * Reads the daemon setup from a command's surroundings. `CSBRIDGE_START_COMMAND` names the
 * command that starts the daemon here, for machines where that is not `claude-science serve`.
 */
export function daemonSetup(io: CliIo & { scienceCli: ScienceCli }): DaemonSetup {
  const startCommand = io.env.CSBRIDGE_START_COMMAND;
  return { scienceCli: io.scienceCli, ...(startCommand ? { startCommand } : {}) };
}
