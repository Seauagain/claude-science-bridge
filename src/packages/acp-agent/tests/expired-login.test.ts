import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe("prompting after the CSRF token has gone stale", () => {
  it("refreshes the token and sends the message once", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");

    const turn = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      harness.fake.expireCsrfTokens();
      return runTurn(session, "ping");
    });

    expect(turn).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["ping"], status: "completed" },
    ]);
    // The token was refreshed; the login itself was still good.
    expect(harness.fake.loginCount()).toBe(1);
  });
});

describe("prompting after the login has expired", () => {
  it("logs in again once and answers the prompt as if nothing had happened", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("A beta barrel.");
      turn.complete();
    });
    harness.fake.onNextMessage((turn) => {
      turn.replyText("Eleven strands.");
      turn.complete();
    });

    const turns = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const beforeExpiry = await runTurn(session, "What is the fold of GFP?");
      harness.fake.expireLogins();
      return [beforeExpiry, await runTurn(session, "How many strands?")];
    });

    expect(turns).toEqual([
      { chunks: ["A beta barrel."], stopReason: "end_turn" },
      { chunks: ["Eleven strands."], stopReason: "end_turn" },
    ]);
    expect(harness.fake.loginCount()).toBe(2);
    expect(harness.fake.conversations()).toEqual([
      {
        projectId,
        messages: ["What is the fold of GFP?", "How many strands?"],
        status: "completed",
      },
    ]);
  });

  it("logs in again once for two sessions that find the login expired at the same time", async () => {
    const membranes = await harness.linkedFolder("Membrane transport");
    const folding = await harness.linkedFolder("Protein folding");

    const turns = await harness.withClient(async (context) => {
      const first = await context.buildSession(membranes.folder).start();
      const second = await context.buildSession(folding.folder).start();
      harness.fake.expireLogins();
      return Promise.all([runTurn(first, "ping"), runTurn(second, "ping")]);
    });

    expect(turns).toEqual([
      { chunks: ["pong"], stopReason: "end_turn" },
      { chunks: ["pong"], stopReason: "end_turn" },
    ]);
    expect(harness.fake.loginCount()).toBe(2);
  });

  it("ends the turn with an error that says what to check when the new login is turned away too", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      harness.fake.acceptLogins(false);
      return runTurn(session, "What is the fold of GFP?");
    });

    await expect(failure).rejects.toThrow(/login.*could not be renewed.*csbridge doctor/s);
    // One new login and one retry, not a loop.
    expect(harness.fake.loginCount()).toBe(2);
    expect(harness.fake.conversations()).toEqual([]);
  });

  it("ends the turn with an error that names the cause when no new login can be obtained", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    let loginLinksAvailable = true;
    const scienceCli = (args: readonly string[]) =>
      args[0] === "url" && !loginLinksAvailable
        ? Promise.reject(new Error("spawn claude-science ENOENT"))
        : harness.fake.scienceCli(args);

    const failure = harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        harness.fake.expireLogins();
        loginLinksAvailable = false;
        return runTurn(session, "What is the fold of GFP?");
      },
      { scienceCli },
    );

    await expect(failure).rejects.toThrow(
      /login.*could not be renewed.*Could not run "claude-science url"/s,
    );
  });
});
