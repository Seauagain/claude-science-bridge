import { randomUUID } from "node:crypto";
import { isRecord, type JsonRecord } from "../validate.ts";
import type {
  ExistingConversation,
  FakeConversation,
  FakeTurn,
  ReplyScript,
} from "./fake-conversation.ts";
import { readFurtherMessage } from "./further-message.ts";
import type { Answer } from "./http-exchange.ts";
import {
  frameOf,
  listFrames,
  messagesPage,
  type StoredConversation,
  type StoredMessage,
  TIMESTAMP,
} from "./stored-conversation.ts";

interface Conversation extends StoredConversation {
  /** The messages sent to the conversation, as {@link FakeConversation.messages} reports them. */
  readonly received: string[];
  /** Cancels the turn in progress. Undefined while no turn is running. */
  cancelTurn: (() => void) | undefined;
}

const AGENT_NAME = "OPERON";
const defaultReply: ReplyScript = (turn) => {
  turn.replyText("pong");
  turn.complete();
};

/**
 * The fake daemon's conversations and their turns: the frame and message routes of "REST
 * endpoints used" and the events of "Turn lifecycle" in docs/protocol.md.
 */
export class FakeConversations {
  readonly #conversations: Conversation[] = [];
  readonly #scripts: ReplyScript[] = [];
  readonly #intentIds = new Set<string>();
  readonly #cancelRequests: string[] = [];
  /** Callers of {@link nextTranscriptRead} that are still waiting. */
  readonly #awaitingTranscriptRead: (() => void)[] = [];
  #endingTurnsOnCancel = true;
  readonly #broadcast: (event: JsonRecord) => void;

  /** `broadcast` pushes an event to every open event socket. */
  constructor(broadcast: (event: JsonRecord) => void) {
    this.#broadcast = broadcast;
  }

  /** While false, a cancel is answered as usual but leaves the running turn to its script. */
  endTurnsOnCancel(end: boolean): void {
    this.#endingTurnsOnCancel = end;
  }

  queueScript(script: ReplyScript): void {
    this.#scripts.push(script);
  }

  list(): FakeConversation[] {
    return this.#conversations.map(({ projectId, received, status }) => ({
      projectId,
      messages: [...received],
      status,
    }));
  }

  /** The model and effort of every conversation, in the order of {@link list}. */
  settings(): { model: string | null; effort: string | null }[] {
    return this.#conversations.map(({ model, effort }) => ({ model, effort }));
  }

  countIn(projectId: string): number {
    return this.#conversations.filter((each) => each.projectId === projectId).length;
  }

  cancelRequests(): string[] {
    return [...this.#cancelRequests];
  }

  /** Resolves the next time a page of a transcript is served. */
  nextTranscriptRead(): Promise<void> {
    return new Promise((resolve) => this.#awaitingTranscriptRead.push(resolve));
  }

  /** Adds a conversation that exists already and returns its identifier. */
  add(projectId: string, existing: ExistingConversation): string {
    const conversation = this.#store(projectId, existing.title, "completed", {
      conversationType: existing.conversationType ?? "agent",
      hidden: existing.hidden ?? false,
      updatedAt: existing.updatedAt,
      transcript: [...(existing.transcript ?? [])],
      model: existing.model ?? null,
      effort: existing.effort ?? null,
    });
    return conversation.id;
  }

  /** `POST /projects/<project_id>/request`, for a project that exists. */
  start(projectId: string, body: unknown): Answer {
    const input = isRecord(body) && isRecord(body.input_data) ? body.input_data.request : undefined;
    if (typeof input !== "string") {
      return {
        status: 400,
        body: { detail: "Invalid arguments: body.input_data.request: Required" },
      };
    }

    // docs/protocol.md does not say what the daemon calls a conversation it has just been sent.
    // The fake uses the first message.
    const conversation = this.#store(projectId, input, "processing", {
      model: namedIn(body, "model"),
      effort: namedIn(body, "effort"),
    });
    this.#beginTurn(conversation, input);
    return {
      status: 200,
      body: { root_frame_id: conversation.id, frame_id: conversation.id, status: "accepted" },
    };
  }

  /** `GET /frames?root_only=true&project_id=<id>&limit=<n>`, for a project that exists. */
  listFrames(query: URLSearchParams): Answer {
    return listFrames(this.#conversations, query);
  }

  /** `GET /frames/<id>`. */
  frame(frameId: string): Answer {
    const conversation = this.#conversations.find((candidate) => candidate.id === frameId);
    if (conversation === undefined) return notFound(frameId);
    return { status: 200, body: frameOf(conversation) };
  }

  /** `POST /request`: a further message to an existing conversation. */
  sendFurtherMessage(body: unknown): Answer {
    const message = readFurtherMessage(body, this.#conversations, this.#intentIds);
    if ("refusal" in message) {
      return { status: message.refusal.httpStatus, body: { detail: message.refusal.detail } };
    }
    this.#intentIds.add(message.intentId);
    // A further message can name another model. An effort it names changes nothing: the
    // conversation keeps the one it started with. See docs/protocol.md.
    message.conversation.model = namedIn(body, "model") ?? message.conversation.model;
    this.#beginTurn(message.conversation, message.text);
    return {
      status: 200,
      body: {
        root_frame_id: message.conversation.id,
        frame_id: message.conversation.id,
        status: message.responseStatus,
      },
    };
  }

  /**
   * `POST /frames/<root_id>/cancel`: the running turn ends with status `cancelled`.
   *
   * docs/protocol.md does not say what the daemon answers for a conversation it does not know or
   * one with no running turn. The fake answers 404 and an empty `cancelled_frames` respectively,
   * and changes nothing.
   */
  cancel(conversationId: string): Answer {
    this.#cancelRequests.push(conversationId);
    const conversation = this.#conversations.find(({ id }) => id === conversationId);
    if (conversation === undefined) return notFound(conversationId);
    const running = conversation.cancelTurn !== undefined;
    conversation.cancelTurn?.();
    return {
      status: 200,
      body: { root_frame_id: conversation.id, cancelled_frames: running ? [conversation.id] : [] },
    };
  }

  /** `GET /frames/<id>/messages?from=<n>&limit=<n>`: one page of the transcript. */
  messages(frameId: string, query: URLSearchParams): Answer {
    const conversation = this.#conversations.find(({ id }) => id === frameId);
    if (conversation === undefined) return notFound(frameId);
    const answer = messagesPage(conversation, query);
    if (answer.status === 200) {
      for (const resolve of this.#awaitingTranscriptRead.splice(0)) resolve();
    }
    return answer;
  }

  #store(
    projectId: string,
    name: string,
    status: string,
    frame: Partial<StoredConversation> = {},
  ): Conversation {
    const conversation: Conversation = {
      id: randomUUID(),
      projectId,
      agentName: AGENT_NAME,
      name,
      conversationType: "agent",
      hidden: false,
      updatedAt: TIMESTAMP,
      transcript: [],
      status,
      statusDescription: undefined,
      model: null,
      effort: null,
      ...frame,
      received: [],
      cancelTurn: undefined,
    };
    this.#conversations.push(conversation);
    return conversation;
  }

  /** Emits the events of "Turn lifecycle" in docs/protocol.md, then runs the reply script. */
  #beginTurn(conversation: Conversation, message: string): void {
    // The daemon re-sends the previous turn's final status just before the next turn starts.
    if (conversation.transcript.length > 0) this.#emitStatus(conversation);
    conversation.received.push(message);
    conversation.transcript.push(textMessage("user", message));
    this.#setStatus(conversation, "processing");
    this.#emit(conversation, { type: "frame_activity", phase: "llm_call", iteration: 1 });

    let finished = false;
    let reply = "";
    let announceCancelled = () => {};
    const cancelled = new Promise<void>((resolve) => {
      announceCancelled = resolve;
    });
    const finish = (status: string, description?: string) => {
      if (finished) return;
      finished = true;
      conversation.cancelTurn = undefined;
      if (reply !== "") conversation.transcript.push(textMessage("assistant", reply));
      this.#emit(conversation, { type: "frame_messages_delta", base_idx: 0, appended: null });
      this.#setStatus(conversation, status, description);
    };
    const turn: FakeTurn = {
      conversationId: conversation.id,
      message,
      replyText: (chunk) => {
        if (finished) return;
        reply += chunk;
        this.#emit(conversation, { type: "text_chunk", block_type: "text", chunk });
      },
      reasoningText: (chunk) => {
        if (finished) return;
        this.#emit(conversation, { type: "text_chunk", block_type: "thinking", chunk });
      },
      complete: () => finish("completed"),
      fail: (description) => finish("failed", description),
      cancelled,
    };
    conversation.cancelTurn = () => {
      if (this.#endingTurnsOnCancel) finish("cancelled");
      announceCancelled();
    };

    const script = this.#scripts.shift() ?? defaultReply;
    setImmediate(() => {
      Promise.resolve()
        .then(() => script(turn))
        .catch((error: unknown) => turn.fail(`reply script threw: ${String(error)}`));
    });
  }

  #setStatus(conversation: Conversation, status: string, description?: string): void {
    conversation.status = status;
    conversation.statusDescription = description;
    this.#emitStatus(conversation);
  }

  #emitStatus(conversation: Conversation): void {
    const description = conversation.statusDescription;
    this.#emit(conversation, {
      type: "frame_update",
      status: conversation.status,
      agent_name: conversation.agentName,
      project_id: conversation.projectId,
      conversation_type: "agent",
      has_pending_input: false,
      pending_input_requests: [],
      ...(description === undefined ? {} : { status_description: description }),
    });
  }

  #emit(conversation: Conversation, event: JsonRecord): void {
    this.#broadcast({ ...event, root_frame_id: conversation.id, frame_id: conversation.id });
  }
}

/** A message as the daemon commits one that was sent or streamed as text. */
function textMessage(role: "user" | "assistant", text: string): StoredMessage {
  return { role, content: [{ type: "text", text }] };
}

function notFound(frameId: string): Answer {
  return { status: 404, body: { detail: `Frame ${frameId} not found` } };
}

/** The string a request body holds under `field`, or null when it holds none. */
function namedIn(body: unknown, field: string): string | null {
  const value = isRecord(body) ? body[field] : undefined;
  return typeof value === "string" ? value : null;
}
