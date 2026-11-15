import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeTurn, ReplyScript } from "../../science-daemon/testing.ts";
import { gate } from "./support/gate.ts";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";
import { loadSession } from "./support/loaded-session.ts";
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

const turnShown = (script: ReplyScript) => turnShownBy(harness, script);
const push = (turn: FakeTurn, event: Record<string, unknown>) => pushAbout(harness, turn, event);

/** The identifiers of the tool calls among `updates`, one for each update of a call. */
const toolCallIds = (updates: readonly object[]) =>
  updates.flatMap((update) => ("toolCallId" in update ? [update.toolCallId] : []));

const PYTHON = { name: "python", input: { code: "fit()", human_description: "Fitting the curve" } };

describe("a turn that ends while a tool use is open", () => {
  it("shows a tool that was running when the turn failed as failed", async () => {
    let id: string | undefined;

    const updates = await turnShown((turn) => {
      const [fit] = turn.useTools([PYTHON]);
      id = fit?.id;
      turn.fail("The sandbox ran out of memory");
    });

    expect(updates.at(-1)).toEqual(endedSilently(id, "Fitting the curve", "failed"));
  });

  it("shows a tool the daemon never came to record as failed: it did not run", async () => {
    const updates = await turnShown((turn) => {
      push(turn, {
        type: "frame_activity",
        phase: "tool_stream",
        tool_name: "python",
        tool_id: "toolu_never_recorded",
      });
      turn.replyText("A beta barrel.");
      turn.complete();
    });

    expect(updates).toEqual([
      pending("toolu_never_recorded", "python"),
      replyText("A beta barrel."),
      endedSilently("toolu_never_recorded", "python", "failed"),
    ]);
  });

  it("shows a tool whose result it never saw as completed when the turn completed", async () => {
    let id: string | undefined;

    const updates = await turnShown((turn) => {
      const [fit] = turn.useTools([PYTHON]);
      id = fit?.id;
      turn.complete();
    });

    expect(updates.at(-1)).toEqual(endedSilently(id, "Fitting the curve", "completed"));
  });

  it("ends at once the tool uses of a model call that is tried again", async () => {
    const updates = await turnShown((turn) => {
      push(turn, {
        type: "frame_activity",
        phase: "tool_stream",
        tool_name: "python",
        tool_id: "toolu_abandoned",
      });
      push(turn, { type: "frame_activity", phase: "llm_retry" });
      turn.replyText("A beta barrel.");
      turn.complete();
    });

    expect(updates).toEqual([
      pending("toolu_abandoned", "python"),
      endedSilently("toolu_abandoned", "python", "failed"),
      replyText("A beta barrel."),
    ]);
  });
});

describe("a turn that ends to wait for the user", () => {
  it("leaves the tool use that asks open", async () => {
    let id: string | undefined;

    const updates = await turnShown((turn) => {
      const [plan] = turn.useTools([{ name: "generate_plan", input: { task_summary: "Fit" } }]);
      id = plan?.id;
      // Read from the web client, not observed: a turn that waits without an input request.
      push(turn, { type: "frame_update", status: "awaiting_plan_approval" });
    });

    expect(updates.at(-1)).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title: "generate_plan",
      status: "in_progress",
      rawInput: { task_summary: "Fit" },
    });
  });
});

describe("a tool use the daemon records only after its result", () => {
  it("stays ended, and is not shown as running again", async () => {
    const updates = await turnShown((turn) => {
      const [use, results] = toolRound("toolu_late");
      push(turn, {
        type: "frame_activity",
        phase: "tool_stream",
        tool_name: "python",
        tool_id: "toolu_late",
      });
      push(turn, { type: "frame_messages_delta", base_idx: 2, appended: [results] });
      push(turn, { type: "frame_messages_delta", base_idx: 1, appended: [use, results] });
      turn.complete();
    });

    expect(updates).toEqual([
      pending("toolu_late", "python"),
      ended("toolu_late", "python", "completed", "done"),
    ]);
  });
});

describe("where a turn's tool uses begin", () => {
  it("counts the results in a message that also holds text and a notice of the daemon", async () => {
    const updates = await turnShown((turn) => {
      const [use, results] = toolRound("toolu_now");
      push(turn, {
        type: "frame_messages_delta",
        base_idx: 1,
        appended: [
          use,
          {
            role: "user",
            content: [
              ...(Array.isArray(results?.content) ? results.content : []),
              { type: "text", text: "The kernel was restarted." },
              { type: "text", text: "Skill hint.", _harness_notice: true },
            ],
          },
        ],
      });
      turn.complete();
    });

    expect(toolCallIds(updates)).toEqual(["toolu_now", "toolu_now"]);
    expect(updates.at(-1)).toMatchObject({ status: "completed", rawOutput: "done" });
  });

  it("counts the tool uses in front of a summary or a mark the daemon files as the user's", async () => {
    const updates = await turnShown((turn) => {
      push(turn, {
        type: "frame_messages_delta",
        base_idx: 1,
        appended: [
          ...toolRound("toolu_first"),
          {
            role: "user",
            content: [{ type: "text", text: "Summary so far." }],
            _rolling_summary: { id: "summary-1" },
          },
          ...toolRound("toolu_second"),
          { role: "user", content: [{ type: "text", text: "Next task." }], _task_boundary: true },
          { role: "user", content: "Compute snapshot.", _harness_notice: true },
          ...toolRound("toolu_third"),
          { role: "user", content: [{ type: "text", text: "Hint.", _harness_notice: true }] },
          ...toolRound("toolu_fourth"),
        ],
      });
      turn.complete();
    });

    expect(toolCallIds(updates)).toEqual([
      "toolu_first",
      "toolu_first",
      "toolu_second",
      "toolu_second",
      "toolu_third",
      "toolu_third",
      "toolu_fourth",
      "toolu_fourth",
    ]);
  });

  it("leaves out an earlier turn's tool uses when it reads the transcript after a gap", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    // A conversation from before this adapter process, whose session has shown none of it.
    const conversationId = harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
      transcript: [
        { role: "user", content: [{ type: "text", text: "What is the fold of GFP?" }] },
        ...toolRound("toolu_earlier"),
        { role: "assistant", content: [{ type: "text", text: "A beta barrel." }] },
      ],
    });
    harness.fake.onNextMessage(async (turn) => {
      const transcriptRead = harness.fake.nextTranscriptRead();
      harness.fake.dropEventSockets();
      await transcriptRead;
      turn.replyText("Eleven strands.");
      turn.complete();
    });

    const shown = await harness.withClient(async (context) => {
      const session = await loadSession(harness, context, conversationId, folder);
      const before = shownIn(harness, session.sessionId).length;
      await session.runTurn("How many strands?");
      return shownIn(harness, session.sessionId).slice(before);
    });

    expect(shown).toEqual([replyText("Eleven strands.")]);
  });
});

describe("results in the shapes the daemon has for them", () => {
  it("shows a result made of pieces of text as those pieces", async () => {
    const updates = await turnShown((turn) => {
      push(turn, {
        type: "frame_messages_delta",
        base_idx: 1,
        appended: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_now", name: "skill" }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_now",
                content: [
                  { type: "text", text: "line one" },
                  { type: "text", text: "line two" },
                ],
              },
            ],
          },
        ],
      });
      turn.complete();
    });

    expect(updates.at(-1)).toEqual(ended("toolu_now", "skill", "completed", "line one\nline two"));
  });

  it("shows a tool sent to the background as completed, with the daemon's word that it runs on", async () => {
    let id: string | undefined;
    const running = JSON.stringify({ status: "running", exec_id: "exec_1", message: "Started." });

    const updates = await turnShown((turn) => {
      const [fit] = turn.useTools([{ name: "python", input: { code: "fit()", background: true } }]);
      id = fit?.id;
      fit?.end(running);
      turn.complete();
    });

    expect(updates.at(-1)).toEqual(ended(id, "python", "completed", running));
  });
});

describe("after the event socket was reopened during a turn", () => {
  it("shows the tool uses and the reasoning that follow as they happen", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const firstChunkDelivered = gate();
    let id: string | undefined;
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me look it up. ");
      await firstChunkDelivered.opened;
      const reopened = harness.fake.nextEventSocket();
      const transcriptRead = harness.fake.nextTranscriptRead();
      harness.fake.dropEventSockets();
      await reopened;
      // What follows is not in the transcript when it is read to make up for the gap.
      await transcriptRead;
      turn.reasoningText("Now the search.");
      const [search] = turn.useTools([SEARCH]);
      id = search?.id;
      search?.end("One structure: 1EMA.");
      // The turn goes on only once the client has the result: it must not take the turn's end.
      while (!shownIn(harness, sessionId).some((update) => "rawOutput" in update)) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      turn.replyText("A beta barrel.");
      turn.complete();
    });

    let sessionId = "";
    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      sessionId = session.sessionId;
      await runTurn(session, "What is the fold of GFP?", () => firstChunkDelivered.open());
    });

    const afterTheGap = shownIn(harness, sessionId).slice(1);
    expect(afterTheGap.slice(0, 2)).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Now the search." } },
      pending(id, "search_structures"),
    ]);
    // The reply text of after the gap comes from the transcript, when the turn ends.
    expect(afterTheGap.slice(3)).toEqual([
      ended(id, SEARCHING, "completed", "One structure: 1EMA."),
      replyText("A beta barrel."),
    ]);
  });
});

describe("a turn that stopped to ask and goes on with the next prompt", () => {
  it("does not show the tool calls of before the question a second time", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const ids: (string | undefined)[] = [];
    harness.fake.onNextMessage(async (turn) => {
      const [fit, ask] = turn.useTools([
        PYTHON,
        { name: "request_host_access", input: { host_path: "/data/genomes", mode: "rw" } },
      ]);
      ids.push(fit?.id, ask?.id);
      fit?.end(JSON.stringify({ stdout: "slope 2.1", stderr: "", exit_code: 0 }));
      await turn.ask([{ kind: "host", target: "/data/genomes", requested_mode: "rw" }]);
      // The delta that brings this result holds the whole message again, the first tool included.
      ask?.end("Access granted.");
      turn.replyText("Thanks.");
      turn.complete();
    });
    let allow = false;
    harness.answerPermissions((request) =>
      allow
        ? { outcome: "selected", optionId: request.options[0]?.optionId ?? "" }
        : { outcome: "cancelled" },
    );

    const { first, second } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Analyse my genomes");
      const first = shownIn(harness, session.sessionId);
      allow = true;
      await runTurn(session, "Go on");
      return { first, second: shownIn(harness, session.sessionId).slice(first.length) };
    });

    const ofTheTools = (updates: readonly object[]) =>
      updates.filter((update) => "toolCallId" in update && ids.includes(String(update.toolCallId)));
    expect(ofTheTools(first).at(-1)).toEqual(
      ended(ids[0], "Fitting the curve", "completed", "slope 2.1"),
    );
    // Nothing more about the tool that had ended, and no second `tool_call` for the one that asks.
    expect(ofTheTools(second)).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: ids[1],
        title: "request_host_access",
        status: "in_progress",
        rawInput: { host_path: "/data/genomes", mode: "rw" },
      },
      ended(ids[1], "request_host_access", "completed", "Access granted."),
    ]);
  });
});
