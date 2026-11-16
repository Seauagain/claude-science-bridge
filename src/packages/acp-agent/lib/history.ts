import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TranscriptEntry } from "../../science-daemon/index.ts";
import type { FileReferences } from "./file-references.ts";

/**
 * A transcript in which the replies name their files by full paths: see {@link FileReferences}.
 * `files` learns the folders the transcript's tools worked in on the way.
 */
export async function locatedTranscript(
  transcript: readonly TranscriptEntry[],
  files: FileReferences,
): Promise<TranscriptEntry[]> {
  for (const entry of transcript) {
    if (entry.type === "tool-use") files.learn(entry.input);
  }
  return Promise.all(
    transcript.map(async (entry) =>
      entry.type === "reply-text" ? { ...entry, text: await files.located(entry.text) } : entry,
    ),
  );
}

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

/** The command a user types to read a conversation's earlier messages in the thread. */
export const HISTORY_COMMAND = {
  name: "history",
  description: "Show the earlier messages of this conversation",
} as const;

/**
 * The command that makes a new thread continue a conversation that exists already. It is how a
 * conversation is brought into a client without the client's own import.
 */
export const OPEN_COMMAND = {
  name: "open",
  description: "Continue an existing conversation in this thread and show its earlier messages",
  input: { hint: "conversation identifier" },
} as const;

/**
 * Renders a conversation's transcript as Markdown for reading in a thread, in pieces to send
 * one after the other: a heading whenever the speaker changes, then what was said. A tool use is
 * a line of its own. Clients do not show the history that is replayed when a session is loaded,
 * so this is how a user gets to see it.
 */
export function historyText(transcript: readonly TranscriptEntry[]): string[] {
  const blocks: string[] = [];
  let speaker: string | undefined;
  for (const entry of transcript) {
    const entrySpeaker = entry.type === "user-text" ? "You" : "Claude Science";
    if (entrySpeaker !== speaker) {
      speaker = entrySpeaker;
      blocks.push(`**${speaker}**`);
    }
    blocks.push(
      entry.type === "tool-use" ? `_Tool: ${entry.description ?? entry.toolName}_` : entry.text,
    );
  }
  return blocks.map((block) => `${block}\n\n`);
}
