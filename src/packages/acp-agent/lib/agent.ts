import { randomUUID } from "node:crypto";
import {
  type AgentApp,
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import { findProjectLink } from "../../project-link/index.ts";
import { type ScienceDaemon, ScienceDaemonError } from "../../science-daemon/index.ts";
import { rethrowAsRequestError } from "./errors.ts";
import { historyUpdates } from "./history.ts";
import { answerPrompt, type Session } from "./prompt.ts";

/** What {@link createScienceAgent} needs. */
export interface ScienceAgentOptions {
  /**
   * Connects to the daemon. Called when the first session is opened, and again after a failed
   * attempt, so the agent starts even when the daemon is not running yet.
   */
  readonly connectDaemon: () => Promise<ScienceDaemon>;
  /** This program's version, reported to the client. */
  readonly version: string;
}

/**
 * Builds the ACP agent that fronts Claude Science. Connect it to a stream to serve one client.
 *
 * A session is opened in a working folder. Its first prompt starts a conversation in the
 * project that folder is linked to, and later prompts continue it. The conversations of a
 * folder's project can be listed as sessions, and loading one replays its history and continues
 * it. Sessions run their turns independently of each other; one session takes one prompt at a
 * time.
 */
export function createScienceAgent(options: ScienceAgentOptions): AgentApp {
  const sessions = new Map<string, Session>();
  let connection: Promise<ScienceDaemon> | undefined;
  const daemon = (): Promise<ScienceDaemon> => {
    connection ??= options.connectDaemon().catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
    return connection;
  };

  return agent({ name: "claude-science-bridge" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "claude-science-bridge",
        title: "Claude Science",
        version: options.version,
      },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      // Connect now, so that a setup problem is reported when the session is opened rather than
      // after the user has typed a prompt.
      await daemon().catch(rethrowAsRequestError);
      const sessionId = randomUUID();
      sessions.set(sessionId, { cwd: params.cwd });
      return { sessionId };
    })
    .onRequest(methods.agent.session.list, async ({ params }) => {
      const folder = params.cwd;
      // Sessions are listed per folder: the conversations of the project it is linked to.
      if (folder === undefined || folder === null) return { sessions: [] };
      try {
        const link = await findProjectLink(folder);
        if (link === undefined) return { sessions: [] };
        const conversations = await (await daemon()).listConversations(link.projectId);
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
        const conversationId = sessionId;
        const transcript = await (await daemon()).readTranscript(conversationId);
        // The client fills the thread from these, so they all go out before the answer.
        for (const update of historyUpdates(transcript)) {
          await client.notify(methods.client.session.update, { sessionId, update });
        }
        // A session this process is serving already keeps its state, such as a running prompt.
        if (!sessions.has(sessionId)) sessions.set(sessionId, { cwd: params.cwd, conversationId });
        return {};
      } catch (error) {
        if (error instanceof ScienceDaemonError && error.kind === "not-found") {
          throw RequestError.sessionNotFound(sessionId);
        }
        return rethrowAsRequestError(error);
      }
    })
    .onRequest(methods.agent.session.prompt, ({ params, client }) => {
      const session = sessions.get(params.sessionId);
      if (session === undefined) throw RequestError.sessionNotFound(params.sessionId);
      return answerPrompt(session, params, { client, daemon });
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      // Nothing happens when no prompt is being answered or this one is cancelled already.
      sessions.get(params.sessionId)?.activePrompt?.abort();
    });
}
