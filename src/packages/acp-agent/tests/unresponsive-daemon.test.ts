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

describe("opening a session on a daemon that accepts connections but does not answer", () => {
  it("fails saying the daemon did not answer when the login gets no answer", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.answerRequests(false);

    const opening = harness.withClient((context) => context.buildSession(folder).start(), {
      timing: { requestTimeoutMs: 40 },
    });

    await expect(opening).rejects.toThrow(/Claude Science did not answer within 0\.04 seconds/);
  });
});

describe("losing the event socket to a daemon that no longer answers", () => {
  it("gives up reopening the socket and ends the turn saying the daemon did not answer", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const firstChunkDelivered = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await firstChunkDelivered.opened;
      harness.fake.answerRequests(false);
      harness.fake.dropEventSockets();
    });

    const failure = harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Fold this protein", () => firstChunkDelivered.open());
      },
      { timing: { requestTimeoutMs: 20, reconnectDelayMs: 2, reconnectGiveUpMs: 100 } },
    );

    await expect(failure).rejects.toThrow(
      /connection to Claude Science was lost and could not be restored.*did not answer within 0\.02 seconds/s,
    );
  });
});

describe("prompting a daemon that accepts connections but does not answer", () => {
  it("ends the prompt saying the daemon did not answer, and answers a later prompt once it does", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");

    const { unanswered, later } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        harness.fake.answerRequests(false);
        const unanswered = await runTurn(session, "Fold this protein").catch(String);
        harness.fake.answerRequests(true);
        return { unanswered, later: await runTurn(session, "Try again") };
      },
      { timing: { requestTimeoutMs: 40 } },
    );

    expect(unanswered).toMatch(/Claude Science did not answer within 0\.04 seconds\. Check that/);
    expect(later).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
    // The message that got no answer was never taken up by the daemon.
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["Try again"], status: "completed" },
    ]);
  });
});
