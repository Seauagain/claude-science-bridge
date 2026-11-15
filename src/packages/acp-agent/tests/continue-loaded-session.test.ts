import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gate } from "./support/gate.ts";
import { cancelTurn, type Harness, startHarness } from "./support/harness.ts";
import { loadSession } from "./support/loaded-session.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** A linked folder whose project holds one conversation with an exchange in it. */
async function folderWithConversation() {
  const { folder, projectId } = await harness.linkedFolder("Protein folding");
  const conversationId = harness.fake.addConversation(projectId, {
    title: "Fold of GFP",
    updatedAt: "2026-11-02T10:00:00Z",
    transcript: [
      { role: "user", content: "What is the fold of GFP?" },
      { role: "assistant", content: [{ type: "text", text: "A beta barrel." }] },
    ],
  });
  return { folder, projectId, conversationId };
}

describe("prompting a conversation that was loaded", () => {
  it("continues that conversation instead of starting a new one", async () => {
    const { folder, projectId, conversationId } = await folderWithConversation();
    const continued: string[] = [];
    harness.fake.onNextMessage((turn) => {
      continued.push(turn.conversationId);
      turn.replyText("Eleven.");
      turn.complete();
    });

    const turn = await harness.withClient(async (context) => {
      const session = await loadSession(harness, context, conversationId, folder);
      return session.runTurn("How many strands?");
    });

    expect(turn).toEqual({ chunks: ["Eleven."], stopReason: "end_turn" });
    expect(continued).toEqual([conversationId]);
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["How many strands?"], status: "completed" },
    ]);
  });

  it("sends every later prompt to the same conversation", async () => {
    const { folder, projectId, conversationId } = await folderWithConversation();

    await harness.withClient(async (context) => {
      const session = await loadSession(harness, context, conversationId, folder);
      await session.runTurn("How many strands?");
      await session.runTurn("Where is the chromophore?");
    });

    expect(harness.fake.conversations()).toEqual([
      {
        projectId,
        messages: ["How many strands?", "Where is the chromophore?"],
        status: "completed",
      },
    ]);
  });

  it("stops the running reply when the client cancels", async () => {
    const { folder, projectId, conversationId } = await folderWithConversation();
    const replyUnderWay = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      replyUnderWay.open();
      await turn.cancelled;
    });

    const turn = await harness.withClient(async (context) => {
      const session = await loadSession(harness, context, conversationId, folder);
      const running = session.runTurn("Where is the chromophore?");
      await replyUnderWay.opened;
      await cancelTurn(context, session);
      return running;
    });

    expect(turn.stopReason).toBe("cancelled");
    expect(harness.fake.cancelRequests()).toEqual([conversationId]);
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["Where is the chromophore?"], status: "cancelled" },
    ]);
  });
});
