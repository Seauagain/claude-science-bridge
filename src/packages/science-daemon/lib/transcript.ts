import type { DaemonHttp } from "./http.ts";
import {
  expectArray,
  expectNumber,
  expectRecord,
  expectString,
  isRecord,
  type JsonRecord,
} from "./validate.ts";

/**
 * One thing a conversation's transcript shows the user: text the user typed, text Claude
 * Science replied, or a tool Claude Science used.
 */
export type TranscriptEntry =
  | { readonly type: "user-text"; readonly text: string }
  | { readonly type: "reply-text"; readonly text: string }
  | {
      readonly type: "tool-use";
      /** The daemon's identifier for this use of the tool, unique in the conversation. */
      readonly toolUseId: string;
      /** The tool's programmatic name. */
      readonly toolName: string;
      /** What the tool was doing, in words meant for the user, when the daemon recorded that. */
      readonly description?: string;
    };

const PAGE_SIZE = 100;
const MESSAGES_CALL = "GET /frames/<id>/messages";

/**
 * Reads every message of a conversation's transcript, oldest first, page by page. See
 * `GET /frames/<id>/messages` in docs/protocol.md.
 */
export async function readMessages(http: DaemonHttp, conversationId: string): Promise<unknown[]> {
  const path = `/frames/${encodeURIComponent(conversationId)}/messages`;
  const messages: unknown[] = [];
  for (;;) {
    const page = expectRecord(
      await http.get(`${path}?from=${messages.length}&limit=${PAGE_SIZE}`),
      MESSAGES_CALL,
    );
    const received = expectArray(page, "messages", MESSAGES_CALL);
    messages.push(...received);
    const complete = messages.length >= expectNumber(page, "total", MESSAGES_CALL);
    if (complete || received.length === 0) return messages;
  }
}

/**
 * Reads what a conversation's transcript shows the user, oldest first. See "Conversations and
 * their messages" in docs/protocol.md.
 */
export async function readTranscript(
  http: DaemonHttp,
  conversationId: string,
): Promise<TranscriptEntry[]> {
  const messages = await readMessages(http, conversationId);
  return messages.flatMap((message) => entriesOf(expectRecord(message, MESSAGES_CALL)));
}

function entriesOf(message: JsonRecord): TranscriptEntry[] {
  // The daemon files its own notices under the user's role. The user did not type them.
  if (message._harness_notice === true) return [];
  const { role, content } = message;
  if (role !== "user" && role !== "assistant") return [];
  const blocks =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : expectArray(message, "content", MESSAGES_CALL);
  return blocks.flatMap((block) => (isRecord(block) ? entryOf(role, block) : []));
}

/**
 * Reasoning, tool results and images are not shown, and neither is a kind of block this version
 * does not know.
 */
function entryOf(role: "user" | "assistant", block: JsonRecord): TranscriptEntry[] {
  if (block.type === "text") {
    if (typeof block.text !== "string" || block.text === "") return [];
    return [{ type: role === "user" ? "user-text" : "reply-text", text: block.text }];
  }
  if (block.type === "tool_use") {
    const description = isRecord(block.input) ? block.input.human_description : undefined;
    return [
      {
        type: "tool-use",
        toolUseId: expectString(block, "id", MESSAGES_CALL),
        toolName: expectString(block, "name", MESSAGES_CALL),
        ...(typeof description === "string" && description !== "" ? { description } : {}),
      },
    ];
  }
  return [];
}
