import type { DaemonHttp } from "./http.ts";
import { type InputRequest, parseInputRequests } from "./input-requests.ts";
import { readMessages } from "./transcript.ts";
import { expectArray, expectRecord, expectString, isRecord, type JsonRecord } from "./validate.ts";

/** Where a conversation stands, read over HTTP when events about it may have been missed. */
export interface ConversationState {
  /** The conversation frame's status. */
  readonly status: string;
  /** The daemon's explanation of the status, for example why a turn failed. */
  readonly statusDescription?: string;
  /**
   * The text of the reply that closes the transcript. Empty while the transcript ends with the
   * user's message, that is, while no reply to it has been committed.
   */
  readonly replyText: string;
  /** What the conversation is waiting for the user to approve or answer. Mostly nothing. */
  readonly inputRequests: readonly InputRequest[];
}

const MESSAGES_CALL = "GET /frames/<id>/messages";

/**
 * Reads a conversation's status and the reply its transcript ends with. See `GET /frames/<id>`
 * and `GET /frames/<id>/messages` in docs/protocol.md.
 */
export async function readConversationState(
  http: DaemonHttp,
  conversationId: string,
): Promise<ConversationState> {
  const frameCall = "GET /frames/<id>";
  // The status first. The other way round, a turn that ends between the two reads would be
  // reported as ended with a transcript that does not hold its reply yet.
  const frame = expectRecord(
    await http.get(`/frames/${encodeURIComponent(conversationId)}?shallow=true`),
    frameCall,
  );
  const status = expectString(frame, "status", frameCall);
  const description = frame.status_description;
  const inputRequests = inputRequestsOf(frame);
  const replyText = closingReplyText(await readMessages(http, conversationId));
  return typeof description === "string" && description !== ""
    ? { status, statusDescription: description, replyText, inputRequests }
    : { status, replyText, inputRequests };
}

/**
 * Reads what a conversation is waiting for the user to approve or answer. See "Input
 * requests" in docs/protocol.md.
 */
export async function readInputRequests(
  http: DaemonHttp,
  conversationId: string,
): Promise<InputRequest[]> {
  const frame = await http.get(`/frames/${encodeURIComponent(conversationId)}?shallow=true`);
  return inputRequestsOf(expectRecord(frame, "GET /frames/<id>"));
}

/**
 * A frame served over HTTP has its pending requests in its output. They count only while the
 * frame waits or runs: what a frame's output holds can be left over from a turn that ended.
 */
function inputRequestsOf(frame: JsonRecord): InputRequest[] {
  if (frame.status !== "awaiting_user_response" && frame.status !== "processing") return [];
  const holder = typeof frame.id === "string" ? frame.id : undefined;
  const own = parseInputRequests(frame.pending_input_requests, holder);
  if (own.length > 0) return own;
  return isRecord(frame.output_data)
    ? parseInputRequests(frame.output_data.pending_input_requests, holder)
    : [];
}

/** The text of the last message, if the assistant wrote it. */
function closingReplyText(messages: readonly unknown[]): string {
  for (const entry of messages.toReversed()) {
    const message = expectRecord(entry, MESSAGES_CALL);
    if (message.role === "user") return "";
    if (message.role !== "assistant") continue;
    return expectArray(message, "content", MESSAGES_CALL)
      .map((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? block.text
          : "",
      )
      .join("");
  }
  return "";
}
