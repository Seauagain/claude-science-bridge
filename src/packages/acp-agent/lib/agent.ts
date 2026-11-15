import { randomUUID } from "node:crypto";
import {
  type AgentApp,
  agent,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import { findProjectLink, ProjectLinkError } from "../../project-link/index.ts";
import { type ScienceDaemon, ScienceDaemonError, type Turn } from "../../science-daemon/index.ts";
import { promptText } from "./prompt-text.ts";

/** What {@link createScienceAgent} needs. */
export interface ScienceAgentOptions {
  /**
   * Connects to the daemon. Called when the first session needs it, and again after a failed
   * attempt, so the agent starts even when the daemon is not running yet.
   */
  readonly connectDaemon: () => Promise<ScienceDaemon>;
  /** This program's version, reported to the client. */
  readonly version: string;
}

/** An ACP session: the client's handle on at most one conversation. */
interface Session {
  readonly projectId: string;
  /** Set by the first prompt, which creates the conversation. */
  conversationId?: string;
  /** The prompt being answered, if any. A session takes one prompt at a time. */
  activePrompt?: ActivePrompt;
}

/** A prompt whose turn has not ended yet. */
interface ActivePrompt {
  /** Set by `session/cancel`. From then on none of the turn's updates are sent to the client. */
  cancelRequested: boolean;
  /** Known once the daemon has accepted the message. */
  turn?: Turn;
}

const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
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
      const link = await findProjectLink(params.cwd).catch(rethrowAsRequestError);
      if (link === undefined) {
        throw new RequestError(
          INVALID_PARAMS,
          `${params.cwd} is not linked to a Claude Science project. ` +
            'Run "csbridge link --project <name>" in that folder, then start a new session.',
        );
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, { projectId: link.projectId });
      return { sessionId };
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

      const active: ActivePrompt = { cancelRequested: false };
      session.activePrompt = active;
      try {
        const message = promptText(params.prompt);
        const science = await daemon();
        const turn =
          session.conversationId === undefined
            ? await science.startConversation(session.projectId, message)
            : await science.sendMessage(session.conversationId, message);
        session.conversationId = turn.conversationId;
        active.turn = turn;
        // The client may have cancelled while the message was on its way to the daemon.
        if (active.cancelRequested) turn.cancel();
        for await (const event of turn.events) {
          // Once the client has cancelled, it gets no further updates for the turn.
          if (event.type === "reply-text" && active.cancelRequested) continue;
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
            // A reply that finished before the daemon could stop it was still cut short for the
            // client, which stopped receiving it when it cancelled.
            const cancelled = active.cancelRequested || event.outcome === "cancelled";
            return { stopReason: cancelled ? "cancelled" : "end_turn" };
          }
        }
        throw new RequestError(
          INTERNAL_ERROR,
          "The connection to Claude Science closed mid-reply.",
        );
      } catch (error) {
        return rethrowAsRequestError(error);
      } finally {
        delete session.activePrompt;
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      const active = sessions.get(params.sessionId)?.activePrompt;
      // Nothing to do when no turn is running or this one is being cancelled already.
      if (active === undefined || active.cancelRequested) return;
      active.cancelRequested = true;
      active.turn?.cancel();
    });
}

/** Passes protocol errors through and turns this project's own errors into protocol errors. */
function rethrowAsRequestError(error: unknown): never {
  if (error instanceof RequestError) throw error;
  if (error instanceof ScienceDaemonError || error instanceof ProjectLinkError) {
    throw new RequestError(INTERNAL_ERROR, error.message);
  }
  throw error;
}
