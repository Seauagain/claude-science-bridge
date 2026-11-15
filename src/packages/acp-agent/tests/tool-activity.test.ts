import type { ClientContext } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeTurn, ReplyScript } from "../../science-daemon/testing.ts";
import { gate } from "./support/gate.ts";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";
import {
  ended,
  endedSilently,
  pending,
  pushAbout,
  replyText,
  SEARCH,
  SEARCHING,
  shownIn,
  toolRound,
  turnShownBy,
} from "./support/shown-turn.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

const shown = (sessionId: string) => shownIn(harness, sessionId);
const turnShown = (script: ReplyScript) => turnShownBy(harness, script);
const push = (turn: FakeTurn, event: Record<string, unknown>) => pushAbout(harness, turn, event);

describe("a turn in which Claude Science uses a tool", () => {
  it("shows the tool use as a tool call, from the moment the tool is named to its result", async () => {
    let id: string | undefined;

    const updates = await turnShown((turn) => {
      turn.replyText("Let me look it up. ");
      const [search] = turn.useTools([SEARCH]);
      id = search?.id;
      search?.end("One structure: 1EMA.");
      turn.replyText("A beta barrel.");
      turn.complete();
    });

    expect(updates).toEqual([
      replyText("Let me look it up. "),
      pending(id, "search_structures"),
      {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        title: SEARCHING,
        status: "in_progress",
        rawInput: { query: "GFP" },
      },
      ended(id, SEARCHING, "completed", "One structure: 1EMA."),
      replyText("A beta barrel."),
    ]);
  });

  it("titles a tool call with the tool's name when the tool use has no description", async () => {
    let id: string | undefined;

    const updates = await turnShown((turn) => {
      const [render] = turn.useTools([{ name: "render_structure", input: { id: "1EMA" } }]);
      id = render?.id;
      render?.end("");
      turn.complete();
    });

    expect(updates).toEqual([
      pending(id, "render_structure"),
      {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        title: "render_structure",
        status: "in_progress",
        rawInput: { id: "1EMA" },
      },
      // A tool that gave nothing back has no output to show.
      endedSilently(id, "render_structure", "completed"),
    ]);
  });

  it("shows several tools called for at once, each ending with its own result", async () => {
    const ids: (string | undefined)[] = [];

    const updates = await turnShown((turn) => {
      const [search, fetch] = turn.useTools([
        SEARCH,
        { name: "fetch_entry", input: { id: "1EMA", human_description: "Fetching entry 1EMA" } },
      ]);
      ids.push(search?.id, fetch?.id);
      // The results come in as the tools end, not in the order the tools were called for.
      fetch?.end("Resolution 1.9 A.");
      search?.end("One structure: 1EMA.");
      turn.complete();
    });

    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
      "tool_call_update",
      "tool_call_update",
    ]);
    expect(updates.slice(4)).toEqual([
      ended(ids[1], "Fetching entry 1EMA", "completed", "Resolution 1.9 A."),
      ended(ids[0], SEARCHING, "completed", "One structure: 1EMA."),
    ]);
  });

  it("shows what a code tool printed, and as failed one that exits with an error", async () => {
    const ids: (string | undefined)[] = [];

    const updates = await turnShown((turn) => {
      const input = { code: "fit()", human_description: "Fitting the curve" };
      const [first] = turn.useTools([{ name: "python", input }]);
      first?.end(JSON.stringify({ stdout: "slope 2.1\n", stderr: "", exit_code: 0 }));
      const [second] = turn.useTools([{ name: "python", input }]);
      second?.end(
        JSON.stringify({ stdout: "starting\n", stderr: "ValueError: no data", exit_code: 1 }),
      );
      ids.push(first?.id, second?.id);
      turn.complete();
    });

    expect(updates.filter((update) => "rawOutput" in update)).toEqual([
      ended(ids[0], "Fitting the curve", "completed", "slope 2.1"),
      ended(ids[1], "Fitting the curve", "failed", "starting\nValueError: no data\nexit code 1"),
    ]);
  });

  it("shows as failed a tool use the daemon marks as an error, or that only reports one", async () => {
    const ids: (string | undefined)[] = [];

    const updates = await turnShown((turn) => {
      const [marked] = turn.useTools([SEARCH]);
      marked?.end("The database is offline.", { error: true });
      const [reporting] = turn.useTools([SEARCH]);
      reporting?.end(JSON.stringify({ error: "No such database" }));
      ids.push(marked?.id, reporting?.id);
      turn.complete();
    });

    expect(updates.filter((update) => "rawOutput" in update)).toEqual([
      ended(ids[0], SEARCHING, "failed", "The database is offline."),
      ended(ids[1], SEARCHING, "failed", "No such database"),
    ]);
  });

  it("shows a web search, which the daemon records together with what it found", async () => {
    const updates = await turnShown((turn) => {
      push(turn, {
        type: "frame_messages_delta",
        base_idx: 1,
        appended: [
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_search",
                name: "web_search",
                input: { query: "GFP fold" },
              },
              {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_search",
                content: [
                  {
                    type: "web_search_result",
                    title: "Green fluorescent protein",
                    url: "https://example.org/gfp",
                  },
                  { type: "web_search_result", title: "1EMA", url: "https://example.org/1ema" },
                ],
              },
            ],
          },
        ],
      });
      turn.complete();
    });

    expect(updates).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "srvtoolu_search",
        title: "web_search",
        status: "in_progress",
        rawInput: { query: "GFP fold" },
      },
      ended(
        "srvtoolu_search",
        "web_search",
        "completed",
        "Green fluorescent protein (https://example.org/gfp)\n1EMA (https://example.org/1ema)",
      ),
    ]);
  });

  it("shows a web search that failed as failed, with the reason", async () => {
    const updates = await turnShown((turn) => {
      push(turn, {
        type: "frame_messages_delta",
        base_idx: 1,
        appended: [
          {
            role: "assistant",
            content: [
              { type: "server_tool_use", id: "srvtoolu_search", name: "web_search", input: {} },
              {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_search",
                content: { type: "web_search_tool_result_error", error_code: "too_many_requests" },
              },
            ],
          },
        ],
      });
      turn.complete();
    });

    expect(updates.at(-1)).toEqual(
      ended("srvtoolu_search", "web_search", "failed", "too_many_requests"),
    );
  });

  it("shows nothing for what it cannot read as tool activity", async () => {
    const updates = await turnShown((turn) => {
      push(turn, { type: "frame_activity", phase: "tool_stream" });
      push(turn, { type: "frame_activity", phase: "tool_exec", tool_count: 1 });
      // The web client reads this as "read the transcript again". It was never seen.
      push(turn, { type: "frame_messages_delta", base_idx: 0, appended: null });
      push(turn, {
        type: "frame_messages_delta",
        base_idx: 1,
        appended: [
          "not a message",
          { role: "assistant", content: [{ type: "tool_use", name: "nameless" }, "not a block"] },
          // A result of a tool use that was never shown.
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_unknown" }] },
        ],
      });
      turn.replyText("A beta barrel.");
      turn.complete();
    });

    expect(updates).toEqual([replyText("A beta barrel.")]);
  });

  it("ignores the tool uses of other conversations and of sub-agent frames", async () => {
    const updates = await turnShown((turn) => {
      const named = { type: "frame_activity", phase: "tool_stream", tool_name: "python" };
      harness.fake.broadcast({
        ...named,
        tool_id: "toolu_elsewhere",
        root_frame_id: "another-conversation",
        frame_id: "another-conversation",
      });
      push(turn, { ...named, tool_id: "toolu_sub_agent", frame_id: "a-sub-agent-frame" });
      turn.replyText("A beta barrel.");
      turn.complete();
    });

    expect(updates).toEqual([replyText("A beta barrel.")]);
  });
});

describe("the tool uses of a conversation's earlier turns", () => {
  it("are not shown when the daemon repeats them in front of the user's next message", async () => {
    const updates = await turnShown((turn) => {
      push(turn, {
        type: "frame_messages_delta",
        base_idx: 0,
        appended: [
          ...toolRound("toolu_earlier"),
          { role: "user", content: "What is the fold of GFP?" },
          ...toolRound("toolu_now"),
        ],
      });
      turn.complete();
    });

    expect(updates.map((update) => "toolCallId" in update && update.toolCallId)).toEqual([
      "toolu_now",
      "toolu_now",
    ]);
  });
});

describe("a turn in which Claude Science reasons", () => {
  it("shows the reasoning as thoughts, in order with the reply, and leaves out empty pieces", async () => {
    const updates = await turnShown((turn) => {
      turn.reasoningText("");
      turn.reasoningText("The user asks about GFP. ");
      turn.replyText("A beta barrel.");
      turn.reasoningText("That answers it.");
      turn.complete();
    });

    const thought = (text: string) => ({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    });
    expect(updates).toEqual([
      thought("The user asks about GFP. "),
      replyText("A beta barrel."),
      thought("That answers it."),
    ]);
  });
});

describe("losing the event socket while Claude Science uses tools", () => {
  /** Runs a turn in a session of its own and returns the session's identifier. */
  async function sessionOfTurn(context: ClientContext, folder: string, onChunk: () => void) {
    const session = await context.buildSession(folder).start();
    await runTurn(session, "What is the fold of GFP?", onChunk);
    return session.sessionId;
  }

  it("shows the tool uses it missed, and each tool call once", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const firstChunkDelivered = gate();
    const ids: (string | undefined)[] = [];
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me look it up. ");
      const [search] = turn.useTools([SEARCH]);
      await firstChunkDelivered.opened;
      const reopened = harness.fake.nextEventSocket();
      harness.fake.dropEventSockets();
      // While nobody is listening: the first tool ends, and a second is used from start to end.
      search?.end("One structure: 1EMA.");
      const [fetch] = turn.useTools([
        { name: "fetch_entry", input: { id: "1EMA", human_description: "Fetching entry 1EMA" } },
      ]);
      fetch?.end("Resolution 1.9 A.");
      ids.push(search?.id, fetch?.id);
      await reopened;
      turn.replyText("A beta barrel.");
      turn.complete();
    });

    const sessionId = await harness.withClient((context) =>
      sessionOfTurn(context, folder, () => firstChunkDelivered.open()),
    );

    const toolCalls = shown(sessionId).filter((update) => "toolCallId" in update);
    expect(toolCalls.slice(2)).toEqual([
      ended(ids[0], SEARCHING, "completed", "One structure: 1EMA."),
      {
        sessionUpdate: "tool_call",
        toolCallId: ids[1],
        title: "Fetching entry 1EMA",
        status: "in_progress",
        rawInput: { id: "1EMA" },
      },
      ended(ids[1], "Fetching entry 1EMA", "completed", "Resolution 1.9 A."),
    ]);
    expect(toolCalls).toHaveLength(5);
  });
});
