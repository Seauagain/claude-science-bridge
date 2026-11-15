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
