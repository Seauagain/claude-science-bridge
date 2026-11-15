import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectScienceDaemon, type ScienceDaemon, type Turn, type TurnEvent } from "../index.ts";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../testing.ts";

let fake: FakeScienceDaemon;
let daemon: ScienceDaemon | undefined;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
});

afterEach(async () => {
  daemon?.close();
  await fake.close();
});

async function eventsOf(turn: Turn): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of turn.events) events.push(event);
  return events;
}

describe("a tool use the daemon records only after its result", () => {
  // At the daemon's own interface: an ACP session drops what follows the end of a tool call.
  it("is reported as started and as ended, and not as detailed after that", async () => {
    daemon = await connectScienceDaemon({ scienceCli: fake.scienceCli });
    const use = { type: "tool_use", id: "toolu_late", name: "python", input: { code: "fit()" } };
    const result = { type: "tool_result", tool_use_id: "toolu_late", content: "done" };
    fake.onNextMessage((turn) => {
      const about = { root_frame_id: turn.conversationId, frame_id: turn.conversationId };
      fake.broadcast({
        ...about,
        type: "frame_activity",
        phase: "tool_stream",
        tool_name: "python",
        tool_id: "toolu_late",
      });
      const results = { role: "user", content: [result] };
      fake.broadcast({ ...about, type: "frame_messages_delta", base_idx: 2, appended: [results] });
      fake.broadcast({
        ...about,
        type: "frame_messages_delta",
        base_idx: 1,
        appended: [{ role: "assistant", content: [use] }, results],
      });
      turn.complete();
    });

    const turn = await daemon.startConversation(
      fake.addProject("Protein folding"),
      "Fit the curve",
      new AbortController().signal,
    );

    const toolUse = { toolUseId: "toolu_late", toolName: "python" };
    expect(await eventsOf(turn)).toEqual([
      { type: "tool-started", toolUse },
      { type: "tool-ended", toolUse, failed: false, output: "done" },
      { type: "ended", outcome: "completed" },
    ]);
  });
});

describe("what the daemon sends about a conversation before its next turn has started", () => {
  // Driven at the daemon's own interface: an ACP session first asks whether the conversation
  // waits for an answer, and a message cannot be held on its way after that question.
  it("is not taken for tool activity of that turn", async () => {
    let holdLoginLink = false;
    let linkAsked = () => {};
    const asked = new Promise<void>((resolve) => {
      linkAsked = resolve;
    });
    let handOutLink = () => {};
    const released = new Promise<void>((resolve) => {
      handOutLink = resolve;
    });
    daemon = await connectScienceDaemon({
      scienceCli: async (args) => {
        if (args[0] === "url" && holdLoginLink) {
          linkAsked();
          await released;
        }
        return fake.scienceCli(args);
      },
    });
    const never = new AbortController().signal;
    const first = await daemon.startConversation(fake.addProject("Protein folding"), "Hi", never);
    await eventsOf(first);

    // The message is turned away for its login and waits for a new one, while the turn that
    // will follow it is listening already.
    fake.expireLogins();
    holdLoginLink = true;
    const sending = daemon.sendMessage(first.conversationId, "How many strands?", never);
    await asked;
    fake.broadcast({
      type: "frame_messages_delta",
      root_frame_id: first.conversationId,
      frame_id: first.conversationId,
      base_idx: 2,
      appended: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_earlier", name: "python", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_earlier", content: "done" }],
        },
      ],
    });
    handOutLink();

    expect(await eventsOf(await sending)).toEqual([
      { type: "reply-text", text: "pong" },
      { type: "ended", outcome: "completed" },
    ]);
  });
});
