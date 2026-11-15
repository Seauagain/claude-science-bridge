import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActiveSession,
  type ClientContext,
  client,
  methods,
  PROTOCOL_VERSION,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { writeProjectLink } from "../../../project-link/index.ts";
import {
  type ConnectionTiming,
  connectScienceDaemon,
  type ScienceCli,
  type ScienceDaemon,
} from "../../../science-daemon/index.ts";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../../science-daemon/testing.ts";
import { createScienceAgent } from "../../index.ts";

/** Everything a test needs: a fake daemon, temporary folders, and an ACP client on the agent. */
export interface Harness {
  readonly fake: FakeScienceDaemon;
  /** Creates a project on the fake daemon and a temporary folder linked to it. */
  linkedFolder(projectName: string): Promise<{ folder: string; projectId: string }>;
  /** Creates a temporary folder that is not linked to any project. */
  unlinkedFolder(): Promise<string>;
  /**
   * Runs `use` as an ACP client connected to the agent, already initialized. The agent uses the
   * fake daemon's Science CLI stand-in unless `options.scienceCli` replaces it, and the
   * connection's production timing unless `options.timing` shortens it.
   */
  withClient<T>(
    use: (context: ClientContext) => Promise<T>,
    options?: { scienceCli?: ScienceCli; timing?: Partial<ConnectionTiming> },
  ): Promise<T>;
  /**
   * The updates the harness's clients have been sent for a session so far, oldest first. This
   * is how a test sees the updates of a session it loaded instead of opening it.
   */
  updates(sessionId: string): SessionUpdate[];
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
  const received: SessionNotification[] = [];
  const testClient = client({ name: "test-client" }).onNotification(
    methods.client.session.update,
    ({ params }) => {
      received.push(params);
    },
  );

  return {
    fake,
    async linkedFolder(projectName) {
      const projectId = fake.addProject(projectName);
      const folder = await newFolder();
      await writeProjectLink(folder, { projectId, name: projectName });
      return { folder, projectId };
    },
    unlinkedFolder: newFolder,
    async withClient(use, options = {}) {
      const scienceCli = options.scienceCli ?? fake.scienceCli;
      const connections: Promise<ScienceDaemon>[] = [];
      const agent = createScienceAgent({
        connectDaemon: () => {
          const connection = connectScienceDaemon({ scienceCli, timing: options.timing ?? {} });
          connections.push(connection);
          return connection;
        },
        version: "0.0.0-test",
      });
      try {
        return await testClient.connectWith(agent, async (context) => {
          await context.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          return use(context);
        });
      } finally {
        // A connection left open would go on trying to reach the fake daemon after the test.
        for (const connection of await Promise.allSettled(connections)) {
          if (connection.status === "fulfilled") connection.value.close();
        }
      }
    },
    updates: (sessionId) =>
      received.filter((each) => each.sessionId === sessionId).map((each) => each.update),
    async dispose() {
      await fake.close();
      await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
    },
  };
}

/** Cancels the session's running turn, as a client does when the user stops a reply. */
export function cancelTurn(
  context: ClientContext,
  session: { readonly sessionId: string },
): Promise<void> {
  return context.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
}

/**
 * Sends one prompt and collects the reply text chunks until the turn stops. `onChunk`, if given,
 * is told about each chunk as it arrives, so that a test can act in the middle of a reply.
 */
export async function runTurn(
  session: ActiveSession,
  prompt: string,
  onChunk: (chunk: string) => void = () => {},
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
      onChunk(update.content.text);
    }
  }
}
