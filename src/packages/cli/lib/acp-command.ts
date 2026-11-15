import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createScienceAgent } from "../../acp-agent/index.ts";
import { connectScienceDaemon, type ScienceDaemon } from "../../science-daemon/index.ts";
import { daemonSetup } from "./daemon-setup.ts";
import type { CommandIo } from "./run-cli.ts";

/**
 * `csbridge acp`: serves one ACP client on standard input and output until it disconnects.
 * Standard output carries protocol messages only.
 */
export async function runAcpCommand(io: CommandIo): Promise<number> {
  const connections: Promise<ScienceDaemon>[] = [];
  const agent = createScienceAgent({
    connectDaemon: () => {
      const connection = connectScienceDaemon({
        ...daemonSetup(io),
        onWarning: (message) => io.stderr.write(`csbridge: warning: ${message}\n`),
      });
      connections.push(connection);
      return connection;
    },
    version: await readVersion(),
  });
  const stream = ndJsonStream(Writable.toWeb(io.stdout), Readable.toWeb(io.stdin));
  await agent.connect(stream).closed;

  // An open connection to the daemon would keep the process alive after the client has gone.
  // Attempts that failed were reported to the client when they happened and left nothing open.
  for (const connection of await Promise.allSettled(connections)) {
    if (connection.status === "fulfilled") connection.value.close();
  }
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
