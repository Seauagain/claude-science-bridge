import type { DaemonHttp } from "./http.ts";
import { expectArray, expectNumber, expectRecord, expectString, isRecord } from "./validate.ts";

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
}

const PAGE_SIZE = 100;
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
  const path = `/frames/${encodeURIComponent(conversationId)}`;
  // The status first. The other way round, a turn that ends between the two reads would be
  // reported as ended with a transcript that does not hold its reply yet.
  const frame = expectRecord(await http.get(`${path}?shallow=true`), frameCall);
  const status = expectString(frame, "status", frameCall);
  const description = frame.status_description;
  const replyText = closingReplyText(await readLastPage(http, path));
  return typeof description === "string" && description !== ""
    ? { status, statusDescription: description, replyText }
    : { status, replyText };
}

/** The transcript's last page of messages. Walks there page by page: only the end matters. */
async function readLastPage(http: DaemonHttp, path: string): Promise<unknown[]> {
  let from = 0;
  for (;;) {
    const page = expectRecord(
      await http.get(`${path}/messages?from=${from}&limit=${PAGE_SIZE}`),
      MESSAGES_CALL,
    );
    const messages = expectArray(page, "messages", MESSAGES_CALL);
    const next = from + messages.length;
    if (messages.length === 0 || next >= expectNumber(page, "total", MESSAGES_CALL)) {
      return messages;
    }
    from = next;
  }
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
