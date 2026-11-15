import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";
import { loadSession, replyText, userText } from "./support/loaded-session.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** Opens a session in `folder`, sends one prompt, and returns the session's identifier. */
function promptedSession(folder: string, prompt: string): Promise<string> {
  return harness.withClient(async (context) => {
    const session = await context.buildSession(folder).start();
    await runTurn(session, prompt);
    return session.sessionId;
  });
}

describe("loading a session that an earlier adapter process opened", () => {
  it("replays the history of the conversation its first prompt started", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("A beta barrel.");
      turn.complete();
    });
    const sessionId = await promptedSession(folder, "What is the fold of GFP?");

    const session = await harness.withClient((context) =>
      loadSession(harness, context, sessionId, folder),
    );

    expect(session.history).toEqual([
      userText("What is the fold of GFP?"),
      replyText("A beta barrel."),
    ]);
  });

  it("continues that conversation", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const sessionId = await promptedSession(folder, "What is the fold of GFP?");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("Eleven.");
      turn.complete();
    });

    const turn = await harness.withClient(async (context) => {
      const session = await loadSession(harness, context, sessionId, folder);
      return session.runTurn("How many strands?");
    });

    expect(turn).toEqual({ chunks: ["Eleven."], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      {
        projectId,
        messages: ["What is the fold of GFP?", "How many strands?"],
        status: "completed",
      },
    ]);
  });

  it("does not find a session that was opened but never prompted", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const sessionId = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.sessionId;
    });

    const loading = harness.withClient((context) =>
      loadSession(harness, context, sessionId, folder),
    );

    await expect(loading).rejects.toMatchObject({ code: -32002, data: { sessionId } });
  });

  it("does not find the session when it runs on another state folder", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const sessionId = await promptedSession(folder, "What is the fold of GFP?");
    const anotherStateFolder = await harness.temporaryFolder();

    const loading = harness.withClient(
      (context) => loadSession(harness, context, sessionId, folder),
      { stateFolder: anotherStateFolder },
    );

    await expect(loading).rejects.toMatchObject({ code: -32002, data: { sessionId } });
  });
});

describe("loading a session in the adapter process that opened it", () => {
  it("replays its history and leaves the session on its conversation", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");

    const history = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "What is the fold of GFP?");
      const loaded = await loadSession(harness, context, session.sessionId, folder);
      await runTurn(session, "How many strands?");
      return loaded.history;
    });

    expect(history).toEqual([userText("What is the fold of GFP?"), replyText("pong")]);
    expect(harness.fake.conversations()).toEqual([
      {
        projectId,
        messages: ["What is the fold of GFP?", "How many strands?"],
        status: "completed",
      },
    ]);
  });
});
