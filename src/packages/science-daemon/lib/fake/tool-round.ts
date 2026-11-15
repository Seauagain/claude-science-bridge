import { randomUUID } from "node:crypto";
import type { JsonRecord } from "../validate.ts";
import type { FakeTool, FakeToolUse } from "./fake-conversation.ts";
import type { StoredMessage } from "./stored-conversation.ts";

/** What a round of tool use needs of the turn it is part of. */
export interface ToolRoundTurn {
  /** Pushes an event about the turn's conversation. */
  emit(event: JsonRecord): void;
  /** The conversation's transcript, for the round to add its messages to. */
  readonly transcript: StoredMessage[];
  /** Sends a `frame_messages_delta` for the transcript from `baseIndex` on, as it now is. */
  announce(baseIndex: number): void;
  /** Whether the turn has ended, after which nothing more is recorded. */
  finished(): boolean;
}

/**
 * One round of tool use: the events and messages of "Tool activity" in docs/protocol.md, up to
 * the point where the tools run. `spoken` is the reply text that goes in front of the tool
 * uses. Each returned use, once ended, puts its result into the message that follows.
 */
export function beginToolRound(
  tools: readonly FakeTool[],
  spoken: string,
  turn: ToolRoundTurn,
): FakeToolUse[] {
  const uses = tools.map(({ name, input }) => ({
    type: "tool_use",
    id: `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    name,
    input,
  }));
  for (const { id, name } of uses) {
    turn.emit({
      type: "frame_activity",
      phase: "tool_stream",
      tool_name: name,
      tool_id: id,
      is_server: false,
    });
  }
  turn.emit({ type: "frame_activity", phase: "tool_exec", tool_count: uses.length });

  const baseIndex = turn.transcript.length;
  const results: JsonRecord[] = [];
  let running = uses.length;
  const said = spoken === "" ? [] : [{ type: "text", text: spoken }];
  turn.transcript.push({ role: "assistant", content: [...said, ...uses] });
  turn.announce(baseIndex);
  // The message for the results is there, empty, before any tool has ended.
  turn.transcript.push({ role: "user", content: results });
  turn.announce(baseIndex);

  return uses.map(({ id }) => ({
    id,
    end(content, options = {}) {
      if (turn.finished()) return;
      results.push({
        type: "tool_result",
        tool_use_id: id,
        content,
        ...(options.error === true ? { is_error: true } : {}),
      });
      // The daemon often says the same thing twice.
      turn.announce(baseIndex);
      turn.announce(baseIndex);
      // With the last result in, the model is called again.
      running -= 1;
      if (running === 0) turn.emit({ type: "frame_activity", phase: "llm_call" });
    },
  }));
}
