import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gate } from "./support/gate.ts";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe("two sessions with turns running at the same time", () => {
  it("gives each session only its own reply and ends each turn on its own", async () => {
    const membranes = await harness.linkedFolder("Membrane transport");
    const folding = await harness.linkedFolder("Protein folding");
    const slowTurnRunning = gate();
    const slowTurnMayEnd = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Through channels ");
      slowTurnRunning.open();
      await slowTurnMayEnd.opened;
      turn.replyText("and pumps.");
      turn.complete();
    });
    harness.fake.onNextMessage((turn) => {
      turn.replyText("A beta ");
      turn.replyText("barrel.");
      turn.complete();
    });

    const { slow, quick } = await harness.withClient(async (context) => {
      const slowSession = await context.buildSession(membranes.folder).start();
      const quickSession = await context.buildSession(folding.folder).start();
      const slow = runTurn(slowSession, "How do ions cross a membrane?");
      await slowTurnRunning.opened;
      // The quick session's whole turn happens while the slow session is mid-reply.
      const quick = await runTurn(quickSession, "What is the fold of GFP?");
      slowTurnMayEnd.open();
      return { slow: await slow, quick };
    });

    expect(quick).toEqual({ chunks: ["A beta ", "barrel."], stopReason: "end_turn" });
    expect(slow).toEqual({ chunks: ["Through channels ", "and pumps."], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      {
        projectId: membranes.projectId,
        messages: ["How do ions cross a membrane?"],
        status: "completed",
      },
      { projectId: folding.projectId, messages: ["What is the fold of GFP?"], status: "completed" },
    ]);
  });

  it("keeps one session's turn running when the other session's turn fails", async () => {
    const membranes = await harness.linkedFolder("Membrane transport");
    const folding = await harness.linkedFolder("Protein folding");
    const slowTurnRunning = gate();
    const slowTurnMayEnd = gate();
    harness.fake.onNextMessage(async (turn) => {
      slowTurnRunning.open();
      await slowTurnMayEnd.opened;
      turn.replyText("Through channels and pumps.");
      turn.complete();
    });
    harness.fake.onNextMessage((turn) => turn.fail("The sandbox ran out of memory"));

    const { slow, failed } = await harness.withClient(async (context) => {
      const slowSession = await context.buildSession(membranes.folder).start();
      const failingSession = await context.buildSession(folding.folder).start();
      const slow = runTurn(slowSession, "How do ions cross a membrane?");
      await slowTurnRunning.opened;
      const failed = await runTurn(failingSession, "Fold this protein").catch(String);
      slowTurnMayEnd.open();
      return { slow: await slow, failed };
    });

    expect(failed).toMatch(/The sandbox ran out of memory/);
    expect(slow).toEqual({ chunks: ["Through channels and pumps."], stopReason: "end_turn" });
  });
});
