import { randomUUID } from "node:crypto";
import { isRecord, type JsonRecord } from "../validate.ts";
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

/** A turn in progress on the fake daemon, handed to a {@link ReplyScript}. */
export interface FakeTurn {
  /** Identifier of the conversation the turn belongs to. */
  readonly conversationId: string;
  /** The user message that started the turn. */
  readonly message: string;
  /** Streams one piece of reply text. An empty piece is sent as such, as the daemon does. */
  replyText(chunk: string): void;
  /** Streams one piece of reasoning text, which does not become part of the reply. */
  reasoningText(chunk: string): void;
  /** Ends the turn successfully. */
  complete(): void;
  /** Ends the turn as failed, with the reason the daemon would report. */
  fail(description: string): void;
  /**
   * Resolves when a cancel is requested for the turn through `POST /frames/<id>/cancel`. A script
   * that awaits it keeps the reply running until then.
   */
  readonly cancelled: Promise<void>;
}

/** Decides how the fake daemon answers one message. */
export type ReplyScript = (turn: FakeTurn) => void | Promise<void>;

/** What the fake daemon recorded about one conversation. */
export interface FakeConversation {
  readonly projectId: string;
  /**
   * The messages the daemon was sent for this conversation, in the order they arrived. The
   * transcript an {@link ExistingConversation} came with is not among them.
   */
  readonly messages: readonly string[];
  /** The conversation frame's current status. */
  readonly status: string;
}

/**
 * A conversation the daemon holds before the adapter under test has anything to do with it, as
 * one the user had in the browser. Its last turn has ended.
 */
export interface ExistingConversation {
  /** The conversation's title, which is the frame's `name`. */
  readonly title: string;
  /** The frame's `updated_at`, an ISO 8601 timestamp. */
  readonly updatedAt: string;
  /** Whether the frame is marked `is_hidden`. Default: false. */
  readonly hidden?: boolean;
  /**
   * The frame's `conversation_type`. Default: `"agent"`, a conversation the user sees. A project
   * also holds frames of other types, for example `"uploads"`.
   */
  readonly conversationType?: string;
  /** The transcript, oldest message first. Default: no messages. */
  readonly transcript?: readonly ExistingMessage[];
}

/** One message of an {@link ExistingConversation}, as the daemon stores and serves it. */
export type ExistingMessage = StoredMessage;

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
    const conversation = this.#store(projectId, input, "processing");
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
