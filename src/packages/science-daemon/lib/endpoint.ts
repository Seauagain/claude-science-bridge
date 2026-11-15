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

/** Asks the Science CLI where the daemon is. Fails with `not-running` when there is none. */
export async function locateDaemon(scienceCli: ScienceCli): Promise<DaemonEndpoint> {
  return parseDaemonStatus(await runScienceCli(scienceCli, ["status"]));
}

/**
 * Reads what `claude-science status` printed. Fails with `not-running` when it reports no
 * daemon. See "Discovery" in docs/protocol.md.
 */
export function parseDaemonStatus(output: string): DaemonEndpoint {
  const call = "claude-science status";
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    throw new ScienceDaemonError("science-cli-failed", `"${call}" did not print JSON.`, { cause });
  }

  const status = expectRecord(parsed, call);
  if (status.running !== true) {
    throw new ScienceDaemonError(
      "not-running",
      "Claude Science is not running. Start it with `claude-science serve` and try again.",
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
