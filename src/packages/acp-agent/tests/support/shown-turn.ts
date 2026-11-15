import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ExistingMessage, FakeTurn, ReplyScript } from "../../../science-daemon/testing.ts";
import { type Harness, runTurn } from "./harness.ts";

/** What a thread shows of a turn: its text, its thoughts and its tool calls. */
const SHOWN = ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"];

/** The updates of a session that show its turns, oldest first. */
export function shownIn(harness: Harness, sessionId: string): SessionUpdate[] {
  return harness.updates(sessionId).filter((update) => SHOWN.includes(update.sessionUpdate));
}

/**
 * Runs one turn in a session of its own, which the fake daemon answers with `script`, and
 * returns what the thread shows. A turn that fails still shows what came before the failure.
 */
export async function turnShownBy(harness: Harness, script: ReplyScript): Promise<SessionUpdate[]> {
  const { folder } = await harness.linkedFolder("Protein folding");
  harness.fake.onNextMessage(script);
  const sessionId = await harness.withClient(async (context) => {
    const session = await context.buildSession(folder).start();
    await runTurn(session, "What is the fold of GFP?").catch(() => {});
    return session.sessionId;
  });
  return shownIn(harness, sessionId);
}

/** Pushes an event about the turn's conversation, as the daemon does. */
export function pushAbout(harness: Harness, turn: FakeTurn, event: Record<string, unknown>): void {
  const ids = { root_frame_id: turn.conversationId, frame_id: turn.conversationId };
  harness.fake.broadcast({ ...ids, ...event });
}

/** A piece of reply text as the thread shows it. */
export const replyText = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});

/** The tool call a use first shows as, while all that is known is which tool. */
export const pending = (toolCallId: string | undefined, toolName: string) => ({
  sessionUpdate: "tool_call",
  toolCallId,
  title: toolName,
  status: "pending",
});

/** The update of a tool call that ended with `output`. */
export const ended = (
  toolCallId: string | undefined,
  title: string,
  status: "completed" | "failed",
  output: string,
) => ({
  sessionUpdate: "tool_call_update",
  toolCallId,
  title,
  status,
  content: [{ type: "content", content: { type: "text", text: output } }],
  rawOutput: output,
});

/** The update of a tool call that ended without giving anything back. */
export const endedSilently = (
  toolCallId: string | undefined,
  title: string,
  status: "completed" | "failed",
) => ({ sessionUpdate: "tool_call_update", toolCallId, title, status });

/** A tool use with a description, and the description. */
export const SEARCH = {
  name: "search_structures",
  input: { query: "GFP", human_description: "Searching the structure database for GFP" },
};
export const SEARCHING = "Searching the structure database for GFP";

/** The transcript messages of a tool use that has ended. */
export const toolRound = (id: string): [ExistingMessage, ExistingMessage] => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "python", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
];
