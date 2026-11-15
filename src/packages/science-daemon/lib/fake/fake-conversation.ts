import type { JsonRecord } from "../validate.ts";
import type { StoredMessage } from "./stored-conversation.ts";

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
  /**
   * Has the assistant use tools, all called for in one message, with the events of "Tool
   * activity" in docs/protocol.md up to the point where the tools run. The reply text streamed
   * so far is committed in that message, in front of the tool uses. Returns the uses in the
   * order given, for the script to end each with its result.
   */
  useTools(tools: readonly FakeTool[]): FakeToolUse[];
  /**
   * Stops the turn to ask the user: the frame goes to `awaiting_user_response` with these input
   * requests pending, each given as the fields the daemon has for its kind (`kind` and what
   * belongs to it). Resolves with the responses once every request has been answered through
   * `POST /frames/<id>/resolve-input`; the turn is then `processing` again and the script
   * carries on.
   */
  ask(requests: readonly JsonRecord[]): Promise<JsonRecord[]>;
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

/** A tool for a {@link FakeTurn} to use: its name and its arguments, as the daemon records them. */
export interface FakeTool {
  readonly name: string;
  /** The arguments, among them `human_description` for a tool use that has one. */
  readonly input: JsonRecord;
}

/** A tool use in progress on the fake daemon. */
export interface FakeToolUse {
  /** The identifier the daemon gave the tool use. */
  readonly id: string;
  /**
   * Ends the tool use with the result the daemon records for it: `content` as it is, and
   * `is_error: true` for a tool that says it failed.
   */
  end(content: string, options?: { readonly error?: boolean }): void;
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
  /** The frame's `model`. Default: none, as for a conversation started without naming one. */
  readonly model?: string;
  /** The frame's `effort`. Default: none. */
  readonly effort?: string;
  /** The transcript, oldest message first. Default: no messages. */
  readonly transcript?: readonly ExistingMessage[];
}

/** One message of an {@link ExistingConversation}, as the daemon stores and serves it. */
export type ExistingMessage = StoredMessage;
