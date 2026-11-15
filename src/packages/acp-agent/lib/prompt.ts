import {
  type AgentContext,
  type McpServer,
  methods,
  type PromptRequest,
  type PromptResponse,
  RequestError,
} from "@agentclientprotocol/sdk";
import {
  type ModelCatalog,
  type ScienceDaemon,
  ScienceDaemonError,
  type TranscriptEntry,
  type Turn,
} from "../../science-daemon/index.ts";
import { settleClientThread } from "./client-thread.ts";
import { INTERNAL_ERROR, INVALID_REQUEST, rethrowAsRequestError } from "./errors.ts";
import type { FolderProjects } from "./folder-project.ts";
import { HISTORY_COMMAND, historyText, OPEN_COMMAND } from "./history.ts";
import { promptText } from "./prompt-text.ts";
import type { SessionRecord } from "./session-record.ts";
import { settingsInForce } from "./settings.ts";

/** An ACP session: the client's handle on at most one conversation. */
export interface Session {
  /** The session's working folder. Its project gets the conversation. */
  readonly cwd: string;
  /** The MCP servers the client handed over when the session was set up. */
  readonly clientServers: readonly McpServer[];
  /** The model the user chose or the conversation has. Absent: the daemon's default. */
  model?: string;
  /** The effort the user chose or the conversation started with. Absent: the default. */
  effort?: string;
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
  /**
   * The daemon's models as last fetched, or nothing when it describes them in a way csbridge
   * cannot read. Read without a request, so that sending a prompt is not held up by it.
   */
  readonly models: () => ModelCatalog | undefined;
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

  const text = promptText(request.prompt).trim();
  if (text === `/${HISTORY_COMMAND.name}`) {
    return showHistory(session, request, surroundings).catch(rethrowAsRequestError);
  }
  const opened = new RegExp(`^/${OPEN_COMMAND.name}\\s+(\\S+)$`).exec(text)?.[1];
  if (opened !== undefined) {
    return openConversation(session, opened, request, surroundings).catch(rethrowAsRequestError);
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

/**
 * Answers the open command: ties the session to a conversation that exists already, so that the
 * thread continues it, and shows its earlier messages. Nothing is sent to Claude Science.
 */
async function openConversation(
  session: Session,
  conversationId: string,
  request: PromptRequest,
  surroundings: PromptSurroundings,
): Promise<PromptResponse> {
  if (session.conversationId !== undefined) {
    throw new RequestError(
      INVALID_REQUEST,
      "This thread already has a conversation, and a thread holds one conversation. " +
        "Open the other conversation in a new thread.",
    );
  }
  // Reading the transcript first proves that the conversation exists before anything is kept.
  const transcript = await (await surroundings.daemon())
    .readTranscript(conversationId)
    .catch((error: unknown) => {
      if (error instanceof ScienceDaemonError && error.kind === "not-found") {
        throw new RequestError(
          INVALID_REQUEST,
          `There is no conversation "${conversationId}" in Claude Science.`,
        );
      }
      throw error;
    });
  session.conversationId = conversationId;
  Object.assign(session, await (await surroundings.daemon()).conversationSettings(conversationId));
  // On record, the conversation is this thread's: it is no longer offered for import, and
  // another adapter process can load the session.
  await surroundings.record.remember(request.sessionId, conversationId);
  const response = await showTranscript(transcript, request, surroundings);
  // A conversation that was only brought in is not work that has just finished.
  await settleClientThread(session.clientServers);
  return response;
}

/**
 * Answers the history command: shows the conversation's earlier messages as reply text. Nothing
 * is sent to Claude Science, so this costs the user nothing.
 */
async function showHistory(
  session: Session,
  request: PromptRequest,
  { client, daemon }: PromptSurroundings,
): Promise<PromptResponse> {
  const transcript =
    session.conversationId === undefined
      ? []
      : await (await daemon()).readTranscript(session.conversationId);
  return showTranscript(transcript, request, { client });
}

/** Sends a transcript to the client as the reply of a turn. */
async function showTranscript(
  transcript: readonly TranscriptEntry[],
  request: PromptRequest,
  { client }: Pick<PromptSurroundings, "client">,
): Promise<PromptResponse> {
  const pieces = historyText(transcript);
  for (const text of pieces.length === 0 ? ["This thread has no earlier messages."] : pieces) {
    await client.notify(methods.client.session.update, {
      sessionId: request.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
  }
  return { stopReason: "end_turn" };
}

/** Sends a message to the session's conversation, starting the conversation if there is none. */
async function sendPrompt(
  session: Session,
  request: PromptRequest,
  cancel: AbortSignal,
  { client, daemon, projectOf, record, models }: PromptSurroundings,
): Promise<Turn> {
  const message = promptText(request.prompt);
  if (session.conversationId !== undefined) {
    // A model the user picked since the last message is used from this one on.
    const settings = session.model === undefined ? {} : { model: session.model };
    return (await daemon()).sendMessage(session.conversationId, message, cancel, settings);
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
  const catalog = models();
  const settings = catalog === undefined ? {} : settingsInForce(catalog, session);
  const turn = await (await daemon()).startConversation(projectId, message, cancel, settings);
  session.conversationId = turn.conversationId;
  // What the conversation started with is what the session shows from now on.
  Object.assign(session, settings);
  // From here on the session can be loaded by another adapter process. If this fails, so does
  // the prompt, although its turn runs on: the user has to learn that the thread will be lost.
  await record.remember(request.sessionId, turn.conversationId);
  return turn;
}
