import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelTurn, type Harness, runTurn, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe("cancelling a running reply", () => {
  it("asks the daemon to cancel the reply and ends the turn as cancelled", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await turn.cancelled;
    });

    const response = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const prompt = session.prompt("Fold this protein");
      // The first update shows that the reply is under way.
      await session.nextUpdate();
      await cancelTurn(context, session);
      return prompt;
    });

    expect(response.stopReason).toBe("cancelled");
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["Fold this protein"], status: "cancelled" },
    ]);
  });

  it("sends no further updates once the client has cancelled", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Too late to be shown");
      await turn.cancelled;
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const turn = runTurn(session, "Fold this protein");
      // Cancelled at once: the daemon has not even accepted the message yet.
      await cancelTurn(context, session);
      return turn;
    });

    expect(chunks).toEqual([]);
    expect(stopReason).toBe("cancelled");
    expect(harness.fake.conversations()[0]?.status).toBe("cancelled");
  });

  it("ends the turn as cancelled even when the reply finished before it could be stopped", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("Done before the cancel arrived");
      turn.complete();
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const turn = runTurn(session, "Fold this protein");
      await cancelTurn(context, session);
      return turn;
    });

    expect(chunks).toEqual([]);
    expect(stopReason).toBe("cancelled");
  });

  it("ends the turn with an error when the daemon cannot be asked to cancel", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await turn.cancelled;
    });

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const prompt = session.prompt("Fold this protein");
      await session.nextUpdate();
      await harness.fake.close();
      await cancelTurn(context, session);
      return prompt;
    });

    await expect(failure).rejects.toThrow(/Could not reach Claude Science/);
  });

  // Sending a further prompt to an existing conversation is ticket #3. Enable this with it.
  it.skip("runs the next prompt in the same conversation after a cancelled turn", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await turn.cancelled;
    });
    harness.fake.onNextMessage((turn) => {
      turn.replyText("It is a beta barrel.");
      turn.complete();
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const cancelled = session.prompt("Fold this protein");
      await session.nextUpdate();
      await cancelTurn(context, session);
      await cancelled;
      // The cancelled prompt's stop message is still queued for this session.
      await session.nextUpdate();
      return runTurn(session, "Just name the fold");
    });

    expect(chunks).toEqual(["It is a beta barrel."]);
    expect(stopReason).toBe("end_turn");
    expect(harness.fake.conversations()).toEqual([
      {
        projectId,
        messages: ["Fold this protein", "Just name the fold"],
        status: "completed",
      },
    ]);
  });
});

describe("cancelling when no turn is running", () => {
  it("leaves a session that has not been prompted yet ready for its first prompt", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await cancelTurn(context, session);
      return runTurn(session, "ping");
    });

    expect(chunks).toEqual(["pong"]);
    expect(stopReason).toBe("end_turn");
  });

  it("does not ask the daemon to cancel a reply that has already ended", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const finished = await context.buildSession(folder).start();
      await runTurn(finished, "ping");
      await cancelTurn(context, finished);
      // A whole turn in another session gives a stray cancel time to reach the daemon.
      await runTurn(await context.buildSession(folder).start(), "ping");
    });

    expect(harness.fake.cancelRequests()).toEqual([]);
    expect(harness.fake.conversations().map(({ status }) => status)).toEqual([
      "completed",
      "completed",
    ]);
  });
});
