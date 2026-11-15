import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActiveSession,
  type ClientContext,
  client,
  methods,
  PROTOCOL_VERSION,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { writeProjectLink } from "../../../project-link/index.ts";
import { connectScienceDaemon } from "../../../science-daemon/index.ts";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../../science-daemon/testing.ts";
import { createScienceAgent } from "../../index.ts";

/** Everything a test needs: a fake daemon, temporary folders, and an ACP client on the agent. */
export interface Harness {
  readonly fake: FakeScienceDaemon;
  /** Creates a project on the fake daemon and a temporary folder linked to it. */
  linkedFolder(projectName: string): Promise<{ folder: string; projectId: string }>;
  /** Creates a temporary folder that is not linked to any project. */
  unlinkedFolder(): Promise<string>;
  /** Runs `use` as an ACP client connected to the agent, already initialized. */
  withClient<T>(use: (context: ClientContext) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const fake = await startFakeScienceDaemon();
  const folders: string[] = [];
  const newFolder = async () => {
    const folder = await mkdtemp(join(tmpdir(), "csbridge-agent-"));
    folders.push(folder);
    return folder;
  };

  return {
    fake,
    async linkedFolder(projectName) {
      const projectId = fake.addProject(projectName);
      const folder = await newFolder();
      await writeProjectLink(folder, { projectId, name: projectName });
      return { folder, projectId };
    },
    unlinkedFolder: newFolder,
    async withClient(use) {
      const agent = createScienceAgent({
        connectDaemon: () => connectScienceDaemon({ scienceCli: fake.scienceCli }),
        version: "0.0.0-test",
      });
      return client({ name: "test-client" }).connectWith(agent, async (context) => {
        await context.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        return use(context);
      });
    },
    async dispose() {
      await fake.close();
      await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
    },
  };
}

/** Sends one prompt and collects the reply text chunks until the turn stops. */
export async function runTurn(
  session: ActiveSession,
  prompt: string,
): Promise<{ chunks: string[]; stopReason: StopReason }> {
  const chunks: string[] = [];
  const finished = session.prompt(prompt);
  // A failed prompt rejects `finished`; without this the loop below would wait forever.
  const failure = finished.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(error),
  );
  for (;;) {
    const message = await Promise.race([session.nextUpdate(), failure]);
    if (message.kind === "stop") return { chunks, stopReason: message.stopReason };
    const { update } = message;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      chunks.push(update.content.text);
    }
  }
}
