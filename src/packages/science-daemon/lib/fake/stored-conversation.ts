import { randomUUID } from "node:crypto";
import type { JsonRecord } from "../validate.ts";
import { type Answer, undocumented } from "./http-exchange.ts";

/** One message of a transcript, as the daemon stores and serves it. */
export interface StoredMessage {
  readonly role: "user" | "assistant";
  /** An array of content blocks or, as the daemon has it for some user messages, a string. */
  readonly content: string | readonly JsonRecord[];
  /** True for a message the daemon added itself, which it marks `_harness_notice`. */
  readonly harnessNotice?: boolean;
  /** Further fields the daemon keeps with the message, such as `_rolling_summary`. */
  readonly marks?: JsonRecord;
}

/** What the fake daemon stores about one conversation: its frame and its transcript. */
export interface StoredConversation {
  readonly id: string;
  readonly projectId: string;
  readonly agentName: string;
  /** The frame's `name`, which is the conversation's title. */
  readonly name: string;
  /** `"agent"` for a conversation the user sees. */
  readonly conversationType: string;
  readonly hidden: boolean;
  readonly updatedAt: string;
  /**
   * The messages committed so far. A reply is committed when its turn ends, as one assistant
   * message; while it is being streamed it is not part of the transcript.
   */
  readonly transcript: StoredMessage[];
  /** The model the conversation runs on, or null when it was started without naming one. */
  model: string | null;
  /** The effort the conversation was started with. The daemon does not change it afterwards. */
  readonly effort: string | null;
  status: string;
  /** Sent along with `status`; the reason when a turn failed. */
  statusDescription: string | undefined;
  /** The input requests the user has not answered yet. Empty unless a turn stopped to ask. */
  pendingRequests: JsonRecord[];
}

/** When the fake daemon says everything it does not keep a time for has happened. */
export const TIMESTAMP = "2026-11-15T08:00:00Z";

/** A frame as `GET /frames/<id>` and `GET /frames` serve it. */
export function frameOf(conversation: StoredConversation): JsonRecord {
  const description = conversation.statusDescription;
  return {
    id: conversation.id,
    root_frame_id: conversation.id,
    parent_frame_id: null,
    project_id: conversation.projectId,
    name: conversation.name,
    agent_name: conversation.agentName,
    status: conversation.status,
    conversation_type: conversation.conversationType,
    is_hidden: conversation.hidden,
    model: conversation.model,
    effort: conversation.effort,
    created_at: TIMESTAMP,
    updated_at: conversation.updatedAt,
    ...(description === undefined ? {} : { status_description: description }),
    // Over HTTP the pending requests are part of the frame's output. See docs/protocol.md.
    ...(conversation.pendingRequests.length === 0
      ? {}
      : { output_data: { pending_input_requests: conversation.pendingRequests } }),
  };
}

/**
 * `GET /frames?root_only=true&project_id=<id>&limit=<n>`: the frames of one project, newest
 * first, whatever their type and whether hidden or not. Every frame the fake holds is a root
 * frame.
 *
 * docs/protocol.md does not say what "newest" goes by. The fake orders by `updated_at` and puts
 * the frame created later first among frames updated at the same time.
 */
export function listFrames(
  conversations: readonly StoredConversation[],
  query: URLSearchParams,
): Answer {
  const limit = Number.parseInt(query.get("limit") ?? "", 10);
  if (query.get("root_only") !== "true" || !(limit > 0)) {
    return undocumented("root_only is not true, or limit is missing");
  }
  const frames = conversations
    .filter(({ projectId }) => projectId === query.get("project_id"))
    .toReversed()
    .sort((one, other) => Date.parse(other.updatedAt) - Date.parse(one.updatedAt))
    .slice(0, limit)
    .map(frameOf);
  return { status: 200, body: frames };
}

/**
 * `GET /frames/<id>/messages?from=<n>&limit=<n>`: one page of the transcript.
 *
 * docs/protocol.md shows the route with both parameters only, so a request without them is
 * refused instead of answered with an invented default.
 */
export function messagesPage(conversation: StoredConversation, query: URLSearchParams): Answer {
  const from = Number.parseInt(query.get("from") ?? "", 10);
  const limit = Number.parseInt(query.get("limit") ?? "", 10);
  if (!(from >= 0 && limit > 0)) return undocumented("from or limit is missing");

  return {
    status: 200,
    body: {
      frame_id: conversation.id,
      from,
      total: conversation.transcript.length,
      messages: conversation.transcript.slice(from, from + limit).map(servedMessage),
    },
  };
}

/**
 * A message as the daemon serves it over HTTP and pushes it in a `frame_messages_delta`.
 *
 * The daemon keeps a message's `_uuid` for good. The fake makes one up each time, which no
 * reader of docs/protocol.md depends on.
 */
export function servedMessage(message: StoredMessage): JsonRecord {
  return {
    role: message.role,
    content: message.content,
    ...(message.harnessNotice ? { _harness_notice: true } : {}),
    ...message.marks,
    _uuid: randomUUID(),
    _ts: TIMESTAMP,
  };
}
