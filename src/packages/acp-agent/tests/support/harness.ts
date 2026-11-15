import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  /**
   * Creates a temporary folder that is not linked to any project. Its last path segment is
   * `name`, or a random one when the name does not matter.
   */
  unlinkedFolder(name?: string): Promise<string>;
  /**
   * The folder the harness's adapters keep their own state in, unless a client is given another
   * one. It does not exist until an adapter creates it.
   */
  readonly stateFolder: string;
  /** Creates an empty temporary folder that is removed with the harness. */
  temporaryFolder(): Promise<string>;
  /**
   * Runs `use` as an ACP client connected to an agent of its own, already initialized. Each call
   * stands for one adapter process: a second call is the adapter the client starts anew, on the
   * same daemon and the same state folder. The agent uses the fake daemon's Science CLI stand-in
   * unless `options.scienceCli` replaces it, the connection's production timing unless
   * `options.timing` shortens it, and the harness's state folder unless `options.stateFolder`
   * names another. The client names itself `options.clientName` when it initializes, and
   * gives no name without it.
   */
  withClient<T>(
    use: (context: ClientContext) => Promise<T>,
    options?: {
      scienceCli?: ScienceCli;
      timing?: Partial<ConnectionTiming>;
      stateFolder?: string;
      clientName?: string;
    },
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
  const stateFolder = join(await newFolder(), "state");
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
    async unlinkedFolder(name) {
      if (name === undefined) return newFolder();
      const folder = join(await newFolder(), name);
      await mkdir(folder);
      return folder;
    },
    stateFolder,
    temporaryFolder: newFolder,
    async withClient(use, options = {}) {
      const scienceCli = options.scienceCli ?? fake.scienceCli;
      const connections: Promise<ScienceDaemon>[] = [];
      const agent = createScienceAgent({
        connectDaemon: () => {
          const connection = connectScienceDaemon({ scienceCli, timing: options.timing ?? {} });
          connections.push(connection);
          return connection;
        },
        stateFolder: options.stateFolder ?? stateFolder,
        version: "0.0.0-test",
      });
      try {
        return await testClient.connectWith(agent, async (context) => {
          await context.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            ...(options.clientName === undefined
              ? {}
              : { clientInfo: { name: options.clientName, version: "0.0.0" } }),
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
