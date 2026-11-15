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

describe("keeping the event socket alive", () => {
  it("pings the daemon while the session is idle", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(
      async (context) => {
        await context.buildSession(folder).start();
        await harness.fake.nextPing();
        await harness.fake.nextPing();
      },
      { timing: { pingIntervalMs: 5 } },
    );
  });

  it("opens a new socket when the daemon stops answering pings", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const { turn, openSockets } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        const reopened = harness.fake.nextEventSocket();
        harness.fake.answerPings(false);
        await reopened;
        harness.fake.answerPings(true);
        const turn = await runTurn(session, "ping");
        return { turn, openSockets: harness.fake.eventConnectionCount() };
      },
      { timing: { pingIntervalMs: 5, pongTimeoutMs: 5 } },
    );

    expect(turn).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
    // The socket that went quiet was given up, not kept next to the new one.
    expect(openSockets).toBe(1);
  });
});

describe("losing the event socket during a turn", () => {
  it("finishes the turn and delivers the reply text it missed, without repeating any", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const firstChunkDelivered = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("The structure ");
      await firstChunkDelivered.opened;
      const reopened = harness.fake.nextEventSocket();
      harness.fake.dropEventSockets();
      // Streamed while nobody is listening.
      turn.replyText("is a beta ");
      await reopened;
      turn.replyText("barrel.");
      turn.complete();
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "What is the fold of GFP?", () => firstChunkDelivered.open());
    });

    expect(chunks.join("")).toBe("The structure is a beta barrel.");
    expect(stopReason).toBe("end_turn");
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["What is the fold of GFP?"], status: "completed" },
    ]);
  });

  it("finishes a turn whose end it missed", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const firstChunkDelivered = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("The structure ");
      await firstChunkDelivered.opened;
      harness.fake.dropEventSockets();
      turn.replyText("is a beta barrel.");
      turn.complete();
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "What is the fold of GFP?", () => firstChunkDelivered.open());
    });

    expect(chunks.join("")).toBe("The structure is a beta barrel.");
    expect(stopReason).toBe("end_turn");
  });

  it("reports a turn that failed while it was not listening, naming the cause", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const firstChunkDelivered = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Starting");
      await firstChunkDelivered.opened;
      harness.fake.dropEventSockets();
      turn.fail("The sandbox ran out of memory");
    });

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Fold this protein", () => firstChunkDelivered.open());
    });

    await expect(failure).rejects.toThrow(/The sandbox ran out of memory/);
  });
});

describe("losing the daemon for good during a turn", () => {
  it("ends the turn saying the daemon is unreachable, and answers a later prompt once it is back", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const firstChunkDelivered = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Let me think about that");
      await firstChunkDelivered.opened;
      await harness.fake.stop();
      // What the real daemon makes of a turn it was running when it stopped is not known. Here
      // the turn does not survive, so that the conversation takes a further message afterwards.
      turn.fail("The daemon stopped");
    });

    const { lostTurn, laterTurn } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        const lostTurn = await runTurn(session, "Fold this protein", () =>
          firstChunkDelivered.open(),
        ).catch(String);
        await harness.fake.start();
        return { lostTurn, laterTurn: await runTurn(session, "Try again") };
      },
      { timing: { reconnectDelayMs: 2, reconnectGiveUpMs: 10 } },
    );

    expect(lostTurn).toMatch(
      /connection to Claude Science was lost and could not be restored.*not running.*claude-science serve/s,
    );
    expect(laterTurn).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["Fold this protein", "Try again"], status: "completed" },
    ]);
  });
});

describe("losing the event socket between turns", () => {
  it("opens a new socket and answers the next prompt", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const turn = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const reopened = harness.fake.nextEventSocket();
      harness.fake.dropEventSockets();
      await reopened;
      return runTurn(session, "ping");
    });

    expect(turn).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
  });

  it("logs in again when the login expired before the socket dropped", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const turn = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const reopened = harness.fake.nextEventSocket();
      harness.fake.expireLogins();
      harness.fake.dropEventSockets();
      await reopened;
      return runTurn(session, "ping");
    });

    expect(turn).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
    expect(harness.fake.loginCount()).toBe(2);
  });

  it("keeps trying until a daemon that was restarted is back, wherever it listens now", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    let daemonIsAway = false;
    const lookedForDaemonWhileAway = gate();
    const scienceCli = (args: readonly string[]) => {
      if (daemonIsAway && args[0] === "status") lookedForDaemonWhileAway.open();
      return harness.fake.scienceCli(args);
    };

    const turn = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        await harness.fake.stop();
        daemonIsAway = true;
        // At least one attempt to reopen the socket fails before the daemon returns.
        await lookedForDaemonWhileAway.opened;
        const reopened = harness.fake.nextEventSocket();
        await harness.fake.start();
        await reopened;
        return runTurn(session, "ping");
      },
      { scienceCli, timing: { reconnectDelayMs: 5 } },
    );

    expect(turn).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
  });
});
