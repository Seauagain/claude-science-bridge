import {
  type AgentContext,
  methods,
  type PromptRequest,
  type PromptResponse,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { ScienceDaemon, Turn } from "../../science-daemon/index.ts";
import { INTERNAL_ERROR, INVALID_REQUEST, rethrowAsRequestError } from "./errors.ts";
import type { FolderProjects } from "./folder-project.ts";
import { promptText } from "./prompt-text.ts";
import type { SessionRecord } from "./session-record.ts";

/** An ACP session: the client's handle on at most one conversation. */
export interface Session {
  /** The session's working folder. Its project gets the conversation. */
  readonly cwd: string;
  /**
   * Set by the first prompt, which creates the conversation, or from the start for a session
   * that was loaded.
   */
  conversationId?: string;
  /**
   * Cancels the prompt being answered, if any. A session takes one prompt at a time. Aborted by
   * `session/cancel`; from then on none of the turn's updates are sent to the client.
   */
  activePrompt?: AbortController;
}

/** What {@link answerPrompt} works with besides the session. */
export interface PromptSurroundings {
  /** The client to send the reply to. */
  readonly client: AgentContext;
  /** The connection to the daemon, made on first use. */
  readonly daemon: () => Promise<ScienceDaemon>;
  /** Finds the project a new conversation of a working folder goes to. */
  readonly projectOf: FolderProjects;
  /** Where a session's conversation is recorded once the first prompt has started it. */
  readonly record: SessionRecord;
}

/**
 * Answers one prompt: sends it to the session's conversation, which the session's first prompt
 * starts, and passes the reply on to the client until the turn ends.
 */
export async function answerPrompt(
  session: Session,
  request: PromptRequest,
  surroundings: PromptSurroundings,
): Promise<PromptResponse> {
  const { client } = surroundings;
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
    const turn = await sendPrompt(session, request, cancel.signal, surroundings);
    // Once the client has cancelled, the turn has no more reply text and ends as cancelled.
    for await (const event of turn.events) {
      if (event.type === "reply-text") {
        await client.notify(methods.client.session.update, {
          sessionId: request.sessionId,
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
    throw new RequestError(INTERNAL_ERROR, "The connection to Claude Science closed mid-reply.");
  } catch (error) {
    // ACP wants a cancelled prompt answered as cancelled, whatever went wrong afterwards.
    if (cancel.signal.aborted) return { stopReason: "cancelled" };
    return rethrowAsRequestError(error);
  } finally {
    delete session.activePrompt;
  }
}

/** Sends a message to the session's conversation, starting the conversation if there is none. */
async function sendPrompt(
  session: Session,
  request: PromptRequest,
  cancel: AbortSignal,
  { client, daemon, projectOf, record }: PromptSurroundings,
): Promise<Turn> {
  const message = promptText(request.prompt);
  if (session.conversationId !== undefined) {
    return (await daemon()).sendMessage(session.conversationId, message, cancel);
  }
  // The folder's project is settled now and not when the session is opened: a client opens
  // sessions in folders of its own choosing just to find out what the agent can do, and those
  // must not leave a project or a link behind.
  const { projectId, note } = await projectOf(session.cwd);
  if (note !== undefined) {
    await client.notify(methods.client.session.update, {
      sessionId: request.sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: note } },
    });
  }
  const turn = await (await daemon()).startConversation(projectId, message, cancel);
  session.conversationId = turn.conversationId;
  // From here on the session can be loaded by another adapter process. If this fails, so does
  // the prompt, although its turn runs on: the user has to learn that the thread will be lost.
  await record.remember(request.sessionId, turn.conversationId);
  return turn;
}
