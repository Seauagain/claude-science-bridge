import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createScienceAgent } from "../../acp-agent/index.ts";
import { connectScienceDaemon, type ScienceCli } from "../../science-daemon/index.ts";
import type { CliIo } from "./run-cli.ts";

/**
 * `csbridge acp`: serves one ACP client on standard input and output until it disconnects.
 * Standard output carries protocol messages only.
 */
export async function runAcpCommand(io: CliIo & { scienceCli: ScienceCli }): Promise<number> {
  const agent = createScienceAgent({
    connectDaemon: () => connectScienceDaemon({ scienceCli: io.scienceCli }),
    version: await readVersion(),
  });
  const stream = ndJsonStream(Writable.toWeb(io.stdout), Readable.toWeb(io.stdin));
  await agent.connect(stream).closed;
  return 0;
}

/** Reads this package's version. The relative path is the same from `src/` and from `dist/`. */
async function readVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
  );
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? manifest.version
      : undefined;
  return typeof version === "string" ? version : "0.0.0";
}
