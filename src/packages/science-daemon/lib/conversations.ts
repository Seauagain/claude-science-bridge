import type { DaemonHttp } from "./http.ts";
import { expectList, expectRecord, expectString } from "./validate.ts";

/** A conversation of a project, as far as this program needs to know it. */
export interface Conversation {
  /** The daemon's identifier for the conversation. */
  readonly conversationId: string;
  /** The title Claude Science shows for the conversation. */
  readonly title: string;
  /** When the conversation last changed, as the daemon reports it: an ISO 8601 timestamp. */
  readonly updatedAt: string;
  /** The model the conversation runs on. Absent when it was started without naming one. */
  readonly model?: string;
}

/**
 * How many frames to ask for. Whether the daemon ever answers with fewer than it has, and how
 * to ask for the rest, is not known, so the limit is set well above what one project holds.
 */
const LIST_LIMIT = 1000;

/**
 * Fetches the conversations of a project that the user sees, in the daemon's order, which is
 * newest first. See "Conversations and their messages" in docs/protocol.md.
 */
export async function listConversations(
  http: DaemonHttp,
  projectId: string,
): Promise<Conversation[]> {
  const call = "GET /frames";
  const frames = await http.get(
    `/frames?root_only=true&project_id=${encodeURIComponent(projectId)}&limit=${LIST_LIMIT}`,
  );
  return (
    expectList(frames, call)
      .map((frame) => expectRecord(frame, call))
      // A project also holds frames that are not conversations, such as its uploads, and
      // conversations the daemon hides from the user.
      .filter((frame) => frame.conversation_type === "agent" && frame.is_hidden !== true)
      .map((frame) => ({
        conversationId: expectString(frame, "id", call),
        title: expectString(frame, "name", call),
        updatedAt: expectString(frame, "updated_at", call),
        ...(typeof frame.model === "string" && frame.model !== "" ? { model: frame.model } : {}),
      }))
  );
}
