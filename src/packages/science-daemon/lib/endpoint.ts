import { ScienceDaemonError } from "./errors.ts";
import { runScienceCli, type ScienceCli } from "./science-cli.ts";
import { expectNumber, expectRecord, expectString } from "./validate.ts";

/** Where a running daemon can be reached. */
export interface DaemonEndpoint {
  /** The daemon's version, as it reports it. */
  readonly version: string;
  /** Base URL for HTTP requests. Always loopback. */
  readonly baseUrl: string;
  /** Value the daemon expects in the `origin` header of writes and of the socket handshake. */
  readonly origin: string;
  /** URL of the event socket, without the query string. */
  readonly socketUrl: string;
}

/** The command that starts the daemon on a plain installation. */
export const DEFAULT_START_COMMAND = "claude-science serve";

/**
 * Asks the Science CLI where the daemon is. Fails with `not-running` when there is none, naming
 * `startCommand` as the way to start one.
 */
export async function locateDaemon(
  scienceCli: ScienceCli,
  startCommand: string = DEFAULT_START_COMMAND,
): Promise<DaemonEndpoint> {
  return parseDaemonStatus(await runScienceCli(scienceCli, ["status"]), startCommand);
}

/**
 * Reads what `claude-science status` printed. Fails with `not-running` when it reports no
 * daemon. See "Discovery" in docs/protocol.md.
 */
export function parseDaemonStatus(
  output: string,
  startCommand: string = DEFAULT_START_COMMAND,
): DaemonEndpoint {
  const call = "claude-science status";
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new ScienceDaemonError(
      "science-cli-failed",
      `"${call}" did not print JSON. Run it in a terminal to see what it prints instead.`,
      { cause },
    );
  }

  const status = expectRecord(parsed, call);
  if (status.running !== true) {
    throw new ScienceDaemonError(
      "not-running",
      `Claude Science is not running. Start it with \`${startCommand}\` and try again.`,
    );
  }
  const port = expectNumber(status, "port", call);
  return {
    version: expectString(status, "version", call),
    baseUrl: `http://127.0.0.1:${port}`,
    origin: `http://localhost:${port}`,
    socketUrl: `ws://127.0.0.1:${port}/api/ws`,
  };
}
