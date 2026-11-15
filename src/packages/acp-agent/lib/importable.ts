import type { Conversation, ScienceDaemon } from "../../science-daemon/index.ts";
import { openSessionRecord } from "./session-record.ts";

/**
 * The conversations of a project that no session has been recorded for, newest first: the ones
 * a client can still bring in. A conversation that a session started, loaded by its own
 * identifier, or opened with the open command is a thread in the client already.
 *
 * `stateFolder` is the folder the adapter keeps its record of sessions in.
 */
export async function conversationsWithoutSession(
  daemon: ScienceDaemon,
  stateFolder: string,
  projectId: string,
): Promise<Conversation[]> {
  const conversations = await daemon.listConversations(projectId);
  const taken = await openSessionRecord(stateFolder).takenConversations();
  return conversations.filter((conversation) => !taken.has(conversation.conversationId));
}
