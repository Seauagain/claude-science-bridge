import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Gate, gate } from "./support/gate.ts";
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
    harness.fake.endTurnsOnCancel(false);
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await turn.cancelled;
      turn.replyText("Too late to be shown");
      turn.complete();
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Fold this protein", () => void cancelTurn(context, session));
    });

    expect(chunks).toEqual(["Let me think about that"]);
    expect(stopReason).toBe("cancelled");
  });

  it("ends the turn as cancelled even when the reply finished before it could be stopped", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.endTurnsOnCancel(false);
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Done before it could be stopped");
      await turn.cancelled;
      turn.complete();
    });

    const { stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Fold this protein", () => void cancelTurn(context, session));
    });

    expect(stopReason).toBe("cancelled");
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["Fold this protein"], status: "completed" },
    ]);
  });

  it("stops the reply of a message that was on its way to the daemon when the client cancelled", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Too late to be shown");
      await turn.cancelled;
    });
    // The message is sent, turned away because the login expired, and sent again after a new
    // login. Holding back the login link keeps the message on its way for as long as it takes.
    const messageOnItsWay = gate();
    const loginLink = gate();
    let loginExpired = false;
    const scienceCli = async (args: readonly string[]) => {
      if (args[0] === "url" && loginExpired) {
        messageOnItsWay.open();
        await loginLink.opened;
      }
      return harness.fake.scienceCli(args);
    };

    const { chunks, stopReason } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        harness.fake.expireLogins();
        loginExpired = true;
        const turn = runTurn(session, "Fold this protein");
        await messageOnItsWay.opened;
        await cancelTurn(context, session);
        // A request answered after the cancel gives the adapter time to have seen the cancel.
        await context.buildSession(folder).start();
        loginLink.open();
        return turn;
      },
      { scienceCli },
    );

    expect(chunks).toEqual([]);
    expect(stopReason).toBe("cancelled");
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["Fold this protein"], status: "cancelled" },
    ]);
  });

  it("ends the turn as cancelled when the daemon does not answer the cancel", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await turn.cancelled;
    });

    const response = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        const prompt = session.prompt("Fold this protein");
        await session.nextUpdate();
        harness.fake.answerRequests(false);
        await cancelTurn(context, session);
        return prompt;
      },
      // The wait for the turn to end runs out long before the wait for the request's answer.
      { timing: { cancelTimeoutMs: 30 } },
    );

    expect(response.stopReason).toBe("cancelled");
    expect(harness.fake.cancelRequests()).toEqual([]);
  });

  it("ends the turn as cancelled when the daemon cannot be asked to cancel", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await turn.cancelled;
    });

    const response = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const prompt = session.prompt("Fold this protein");
      await session.nextUpdate();
      await harness.fake.close();
      await cancelTurn(context, session);
      return prompt;
    });

    expect(response.stopReason).toBe("cancelled");
  });

  it("ends the turn as cancelled when the reply fails after the client cancelled", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.endTurnsOnCancel(false);
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await turn.cancelled;
      turn.fail("The sandbox ran out of memory");
    });

    const response = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const prompt = session.prompt("Fold this protein");
      await session.nextUpdate();
      await cancelTurn(context, session);
      return prompt;
    });

    expect(response.stopReason).toBe("cancelled");
  });

  it("stops waiting for a daemon that takes the cancel but does not end the reply", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.endTurnsOnCancel(false);
    const promptAnswered = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await turn.cancelled;
      // The reply runs on, past the time the adapter waits for it to stop.
      await promptAnswered.opened;
      turn.complete();
    });
    harness.fake.onNextMessage((turn) => {
      turn.replyText("It is a beta barrel.");
      turn.complete();
    });

    const { cancelled, next } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        const prompt = session.prompt("Fold this protein");
        await session.nextUpdate();
        await cancelTurn(context, session);
        const cancelled = await prompt;
        // The cancelled prompt's stop message is still queued for this session.
        await session.nextUpdate();
        promptAnswered.open();
        return { cancelled, next: await runTurn(session, "Just name the fold") };
      },
      { timing: { cancelTimeoutMs: 30 } },
    );

    expect(cancelled.stopReason).toBe("cancelled");
    expect(next).toEqual({ chunks: ["It is a beta barrel."], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      {
        projectId,
        messages: ["Fold this protein", "Just name the fold"],
        status: "completed",
      },
    ]);
  });

  it("runs the next prompt in the same conversation after a cancelled turn", async () => {
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

describe("cancelling before the message has been sent", () => {
  it("does not send the message, and ends the turn as cancelled without waiting", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    // Holds back the adapter's search for the daemon, and with it the reopening of a dropped
    // event socket. A message is not sent before the socket is open again.
    const lookingForDaemon = gate();
    let daemonFound: Gate | undefined;
    const scienceCli = async (args: readonly string[]) => {
      if (args[0] === "status" && daemonFound !== undefined) {
        lookingForDaemon.open();
        await daemonFound.opened;
      }
      return harness.fake.scienceCli(args);
    };

    const { cancelled, later } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        const holdBack = gate();
        daemonFound = holdBack;
        harness.fake.dropEventSockets();
        await lookingForDaemon.opened;
        const turn = runTurn(session, "Fold this protein");
        await cancelTurn(context, session);
        const cancelled = await turn;
        const reopened = harness.fake.nextEventSocket();
        holdBack.open();
        await reopened;
        // A whole turn in another session gives a message sent by mistake time to arrive.
        const other = await context.buildSession(folder).start();
        return { cancelled, later: await runTurn(other, "ping") };
      },
      { scienceCli },
    );

    expect(cancelled).toEqual({ chunks: [], stopReason: "cancelled" });
    expect(later).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["ping"], status: "completed" },
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
