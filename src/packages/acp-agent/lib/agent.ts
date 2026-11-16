import { randomUUID } from "node:crypto";
import {
  type AgentApp,
  type AgentContext,
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import { findProjectLink } from "../../project-link/index.ts";
import {
  type ModelCatalog,
  type ScienceDaemon,
  ScienceDaemonError,
} from "../../science-daemon/index.ts";
import { INVALID_PARAMS, rethrowAsRequestError } from "./errors.ts";
import { FileReferences } from "./file-references.ts";
import { createFolderProjects } from "./folder-project.ts";
import { HISTORY_COMMAND, historyUpdates, locatedTranscript, OPEN_COMMAND } from "./history.ts";
import { conversationsWithoutSession } from "./importable.ts";
import { askingWayOf } from "./input-requests.ts";
import { answerPrompt, type Session } from "./prompt.ts";
import { openSessionRecord } from "./session-record.ts";
import { chooseSetting, settingsOptions } from "./settings.ts";

/** What {@link createScienceAgent} needs. */
export interface ScienceAgentOptions {
  /**
   * Connects to the daemon. Called when the daemon is first needed, which is when a session is
   * opened, loaded or listed, and again after a failed attempt, so the agent starts even when
   * the daemon is not running yet.
   */
  readonly connectDaemon: () => Promise<ScienceDaemon>;
  /**
   * The folder csbridge keeps its own state in: the record of which session belongs to which
   * conversation, which holds identifiers only. The folder is created when the first session
   * is recorded, and is shared by every adapter process of the user. It must not be the Claude
   * Science data folder.
   */
  readonly stateFolder: string;
  /** This program's version, reported to the client. */
  readonly version: string;
}

/**
 * Builds the ACP agent that fronts Claude Science. Connect it to a stream to serve one client.
 *
 * A session is opened in a working folder, any folder. Its first prompt starts a conversation
 * in the project that folder is linked to, and later prompts continue it. A folder that is not
 * linked is linked by that first prompt, to the project that has the folder's name or to a new
 * project of that name. The conversations of a linked folder's project can be listed as
 * sessions, and loading one replays its history and continues it. Sessions run their turns
 * independently of each other; one session takes one prompt at a time.
 */
export function createScienceAgent(options: ScienceAgentOptions): AgentApp {
  const sessions = new Map<string, Session>();
  const record = openSessionRecord(options.stateFolder);
  let connection: Promise<ScienceDaemon> | undefined;
  const daemon = (): Promise<ScienceDaemon> => {
    connection ??= options.connectDaemon().catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
    return connection;
  };
  const projectOf = createFolderProjects(daemon);
  // Known once the client has initialized, which it does before anything else.
  let askingWay = askingWayOf(undefined);
  // The models are asked for anew for each session: the daemon's list can change while this
  // process runs. A list csbridge cannot read costs the model and effort options, not the
  // session.
  let knownModels: ModelCatalog | undefined;
  const models = (): Promise<ModelCatalog | undefined> =>
    daemon()
      .then((science) => science.listModels())
      .then((catalog) => {
        knownModels = catalog;
        return catalog;
      })
      .catch((error: unknown) => {
        if (error instanceof ScienceDaemonError && error.kind === "unexpected-response") {
          return undefined;
        }
        throw error;
      });
  /** The part of a session's answer that tells the client its model and effort options. */
  const optionsOf = async (session: Session) => {
    const catalog = await models();
    return catalog === undefined ? {} : { configOptions: settingsOptions(catalog, session) };
  };

  return agent({ name: "claude-science-bridge" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      askingWay = askingWayOf(params.clientCapabilities);
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: {
          name: "claude-science-bridge",
          title: "Claude Science",
          version: options.version,
        },
        agentCapabilities: {
          loadSession: true,
          // Images and embedded resources reach Claude Science as attachments of the message.
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {} },
        },
        authMethods: [],
      };
    })
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      // Connect now, so that a setup problem is reported when the session is opened rather than
      // after the user has typed a prompt.
      await daemon().catch(rethrowAsRequestError);
      const sessionId = randomUUID();
      const session: Session = {
        cwd: params.cwd,
        clientServers: params.mcpServers,
        toolCalls: new Map(),
        files: new FileReferences(params.cwd),
      };
      sessions.set(sessionId, session);
      await offerCommands(client, sessionId);
      return { sessionId, ...(await optionsOf(session).catch(rethrowAsRequestError)) };
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const folder = params.cwd;
      // Sessions are listed per folder: the conversations of the project it is linked to.
      if (folder === undefined || folder === null) return { sessions: [] };
      try {
        const link = await findProjectLink(folder);
        if (link === undefined) return { sessions: [] };
        // A conversation that a session of the client's own started is a thread there already.
        // Listed, it would be offered for import a second time, under another identifier.
        const conversations = await conversationsWithoutSession(
          await daemon(),
          options.stateFolder,
          link.projectId,
        );
        return {
          sessions: conversations.map((conversation) => ({
            sessionId: conversation.conversationId,
            cwd: folder,
            title: conversation.title,
            updatedAt: conversation.updatedAt,
          })),
        };
      } catch (error) {
        return rethrowAsRequestError(error);
      }
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      const { sessionId } = params;
      try {
        // A session the client opened has an identifier of its own, and its conversation is on
        // record. Any other identifier is that of a conversation the client found in the list.
        const conversationId = (await record.conversationOf(sessionId)) ?? sessionId;
        const science = await daemon();
        const files = sessions.get(sessionId)?.files ?? new FileReferences(params.cwd);
        const transcript = await locatedTranscript(
          await science.readTranscript(conversationId),
          files,
        );
        // The client fills the thread from these, so they all go out before the answer.
        for (const update of historyUpdates(transcript)) {
          await client.notify(methods.client.session.update, { sessionId, update });
        }
        // A session this process is serving already keeps its state, such as a running prompt.
        const session = sessions.get(sessionId) ?? {
          cwd: params.cwd,
          clientServers: params.mcpServers,
          toolCalls: new Map(),
          files,
          conversationId,
          ...(await science.conversationSettings(conversationId)),
        };
        sessions.set(sessionId, session);
        await offerCommands(client, sessionId);
        return await optionsOf(session);
      } catch (error) {
        if (error instanceof ScienceDaemonError && error.kind === "not-found") {
          throw RequestError.sessionNotFound(sessionId);
        }
        return rethrowAsRequestError(error);
      }
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session === undefined) throw RequestError.sessionNotFound(params.sessionId);
      const catalog = await models().catch(rethrowAsRequestError);
      if (catalog === undefined) {
        throw new RequestError(INVALID_PARAMS, `This session has no option "${params.configId}".`);
      }
      chooseSetting(catalog, session, params.configId, params.value);
      return { configOptions: settingsOptions(catalog, session) };
    })
    .onRequest(methods.agent.session.prompt, ({ params, client }) => {
      const session = sessions.get(params.sessionId);
      if (session === undefined) throw RequestError.sessionNotFound(params.sessionId);
      return answerPrompt(session, params, {
        client,
        daemon,
        projectOf,
        record,
        // Every session asked for the models when it was set up; a prompt does not ask again.
        models: () => knownModels,
        askingWay,
        options: (current) =>
          knownModels === undefined ? undefined : settingsOptions(knownModels, current),
      });
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      // Nothing happens when no prompt is being answered or this one is cancelled already.
      sessions.get(params.sessionId)?.activePrompt?.abort();
    });
}

/**
 * Tells the client which commands the session takes. Sent before the session is answered: a
 * client reads a session's commands while it is being set up.
 */
async function offerCommands(client: AgentContext, sessionId: string): Promise<void> {
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [HISTORY_COMMAND, OPEN_COMMAND],
    },
  });
}
