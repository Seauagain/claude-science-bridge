import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TranscriptEntry } from "../../science-daemon/index.ts";

/**
 * Renders a conversation's transcript as the session updates that replay it to a client, in the
 * transcript's order. A tool use becomes a tool call that has completed, whatever came of it:
 * the transcript is history, and nothing in it is still running.
 */
export function historyUpdates(transcript: readonly TranscriptEntry[]): SessionUpdate[] {
  return transcript.map(historyUpdate);
}

function historyUpdate(entry: TranscriptEntry): SessionUpdate {
  const content = (text: string) => ({ type: "text" as const, text });
  switch (entry.type) {
    case "user-text":
      return { sessionUpdate: "user_message_chunk", content: content(entry.text) };
    case "reply-text":
      return { sessionUpdate: "agent_message_chunk", content: content(entry.text) };
    case "tool-use":
      return {
        sessionUpdate: "tool_call",
        toolCallId: entry.toolUseId,
        title: entry.description ?? entry.toolName,
        status: "completed",
      };
  }
}
