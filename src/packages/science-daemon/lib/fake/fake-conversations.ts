import { randomUUID } from "node:crypto";
import { isRecord, type JsonRecord } from "../validate.ts";
import { readFurtherMessage } from "./further-message.ts";
import type { Answer } from "./http-exchange.ts";

/** A turn in progress on the fake daemon, handed to a {@link ReplyScript}. */
export interface FakeTurn {
  /** Identifier of the conversation the turn belongs to. */
  readonly conversationId: string;
  /** The user message that started the turn. */
  readonly message: string;
  /** Streams one piece of reply text. */
  replyText(chunk: string): void;
  /** Ends the turn successfully. */
  complete(): void;
  /** Ends the turn as failed, with the reason the daemon would report. */
  fail(description: string): void;
  /**
   * Resolves when the turn is cancelled through `POST /frames/<id>/cancel`. A script that awaits
   * it keeps the reply running until then.
   */
  readonly cancelled: Promise<void>;
}

/** Decides how the fake daemon answers one message. */
export type ReplyScript = (turn: FakeTurn) => void | Promise<void>;

/** What the fake daemon recorded about one conversation. */
export interface FakeConversation {
  readonly projectId: string;
  /** User messages, in the order they were sent. */
  readonly messages: readonly string[];
  /** The conversation frame's current status. */
  readonly status: string;
}

interface Conversation {
  readonly id: string;
  readonly projectId: string;
  readonly agentName: string;
  readonly messages: string[];
  status: string;
  /** Sent along with `status`; the reason when a turn failed. */
  statusDescription: string | undefined;
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
  readonly #broadcast: (event: JsonRecord) => void;

  /** `broadcast` pushes an event to every open event socket. */
  constructor(broadcast: (event: JsonRecord) => void) {
    this.#broadcast = broadcast;
  }

  queueScript(script: ReplyScript): void {
    this.#scripts.push(script);
  }

  list(): FakeConversation[] {
    return this.#conversations.map(({ projectId, messages, status }) => ({
      projectId,
      messages: [...messages],
      status,
    }));
  }

  countIn(projectId: string): number {
    return this.#conversations.filter((each) => each.projectId === projectId).length;
  }

  cancelRequests(): string[] {
    return [...this.#cancelRequests];
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

    const conversation: Conversation = {
      id: randomUUID(),
      projectId,
      agentName: AGENT_NAME,
      messages: [],
      status: "processing",
      statusDescription: undefined,
      cancelTurn: undefined,
    };
    this.#conversations.push(conversation);
    this.#beginTurn(conversation, input);
    return {
      status: 200,
      body: { root_frame_id: conversation.id, frame_id: conversation.id, status: "accepted" },
    };
  }

  /** `GET /frames/<id>`. */
  frame(frameId: string): Answer {
    const conversation = this.#conversations.find((candidate) => candidate.id === frameId);
    if (conversation === undefined) return notFound(frameId);
    return {
      status: 200,
      body: {
        id: conversation.id,
        root_frame_id: conversation.id,
        parent_frame_id: null,
        project_id: conversation.projectId,
        agent_name: conversation.agentName,
        status: conversation.status,
        conversation_type: "agent",
      },
    };
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

  /** Emits the events of "Turn lifecycle" in docs/protocol.md, then runs the reply script. */
  #beginTurn(conversation: Conversation, message: string): void {
    // The daemon re-sends the previous turn's final status just before the next turn starts.
    if (conversation.messages.length > 0) this.#emitStatus(conversation);
    conversation.messages.push(message);
    this.#setStatus(conversation, "processing");
    this.#emit(conversation, { type: "frame_activity", phase: "llm_call", iteration: 1 });

    let finished = false;
    let announceCancelled = () => {};
    const cancelled = new Promise<void>((resolve) => {
      announceCancelled = resolve;
    });
    const finish = (status: string, description?: string) => {
      if (finished) return;
      finished = true;
      conversation.cancelTurn = undefined;
      this.#emit(conversation, { type: "frame_messages_delta", base_idx: 0, appended: null });
      this.#setStatus(conversation, status, description);
    };
    const turn: FakeTurn = {
      conversationId: conversation.id,
      message,
      replyText: (chunk) => {
        if (!finished) this.#emit(conversation, { type: "text_chunk", block_type: "text", chunk });
      },
      complete: () => finish("completed"),
      fail: (description) => finish("failed", description),
      cancelled,
    };
    conversation.cancelTurn = () => {
      finish("cancelled");
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

function notFound(frameId: string): Answer {
  return { status: 404, body: { detail: `Frame ${frameId} not found` } };
}
