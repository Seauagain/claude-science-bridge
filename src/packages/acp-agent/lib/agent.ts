import { randomUUID } from "node:crypto";
import {
  type AgentApp,
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import { findProjectLink, ProjectLinkError } from "../../project-link/index.ts";
import { type ScienceDaemon, ScienceDaemonError } from "../../science-daemon/index.ts";
import { promptText } from "./prompt-text.ts";

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

/** An ACP session: the client's handle on at most one conversation. */
interface Session {
  /** The session's working folder. The project it is linked to gets the conversation. */
  readonly cwd: string;
  /** Set by the first prompt, which creates the conversation. */
  conversationId?: string;
  /**
   * Cancels the prompt being answered, if any. A session takes one prompt at a time. Aborted by
   * `session/cancel`; from then on none of the turn's updates are sent to the client.
   */
  activePrompt?: AbortController;
}

const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

/**
 * Builds the ACP agent that fronts Claude Science. Connect it to a stream to serve one client.
 *
 * A session belongs to the project its working folder is linked to. Its first prompt starts a
 * conversation in that project and later prompts continue it. Sessions run their turns
 * independently of each other; one session takes one prompt at a time.
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
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const session = sessions.get(params.sessionId);
      if (session === undefined) throw RequestError.sessionNotFound(params.sessionId);
      if (session.activePrompt !== undefined) {
        throw new RequestError(
          INVALID_REQUEST,
          "This session is still answering its previous prompt. " +
            "Wait for that reply to finish, then send the prompt again.",
        );
      }

      const cancel = new AbortController();
      session.activePrompt = cancel;
      try {
        const message = promptText(params.prompt);
        const turn =
          session.conversationId === undefined
            ? await (await daemon()).startConversation(
                await linkedProjectId(session.cwd),
                message,
                cancel.signal,
              )
            : await (await daemon()).sendMessage(session.conversationId, message, cancel.signal);
        session.conversationId = turn.conversationId;
        // Once the client has cancelled, the turn has no more reply text and ends as cancelled.
        for await (const event of turn.events) {
          if (event.type === "reply-text") {
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: event.text },
              },
            });
          } else if (event.outcome === "failed") {
            throw new RequestError(
              INTERNAL_ERROR,
              `Claude Science could not finish the reply: ${event.detail ?? "no reason given"}`,
            );
          } else {
            return { stopReason: event.outcome === "cancelled" ? "cancelled" : "end_turn" };
          }
        }
        throw new RequestError(
          INTERNAL_ERROR,
          "The connection to Claude Science closed mid-reply.",
        );
      } catch (error) {
        // ACP wants a cancelled prompt answered as cancelled, whatever went wrong afterwards.
        if (cancel.signal.aborted) return { stopReason: "cancelled" };
        return rethrowAsRequestError(error);
      } finally {
        delete session.activePrompt;
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      // Nothing happens when no prompt is being answered or this one is cancelled already.
      sessions.get(params.sessionId)?.activePrompt?.abort();
    });
}

/**
 * The project a session's working folder is linked to. The link is looked up when the first
 * prompt arrives, not when the session is opened: a client opens sessions in folders of its
 * own choosing just to find out what the agent can do.
 */
async function linkedProjectId(folder: string): Promise<string> {
  const link = await findProjectLink(folder);
  if (link !== undefined) return link.projectId;
  throw new RequestError(
    INVALID_REQUEST,
    `${folder} is not linked to a Claude Science project. ` +
      'Run "csbridge link --project <name>" in that folder, then send the prompt again.',
  );
}

/** Passes protocol errors through and turns this project's own errors into protocol errors. */
function rethrowAsRequestError(error: unknown): never {
  if (error instanceof RequestError) throw error;
  if (error instanceof ScienceDaemonError || error instanceof ProjectLinkError) {
    throw new RequestError(INTERNAL_ERROR, error.message);
  }
  throw error;
}
