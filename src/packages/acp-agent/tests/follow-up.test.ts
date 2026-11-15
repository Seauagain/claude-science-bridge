import { methods } from "@agentclientprotocol/sdk";
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

describe("prompting a session again", () => {
  it("sends later prompts to the conversation the first prompt created", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("A beta barrel.");
      turn.complete();
    });
    harness.fake.onNextMessage((turn) => {
      turn.replyText("Eleven strands.");
      turn.complete();
    });
    harness.fake.onNextMessage((turn) => {
      turn.replyText("Inside the barrel.");
      turn.complete();
    });

    const turns = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return [
        await runTurn(session, "What is the fold of GFP?"),
        await runTurn(session, "How many strands?"),
        await runTurn(session, "Where is the chromophore?"),
      ];
    });

    expect(turns).toEqual([
      { chunks: ["A beta barrel."], stopReason: "end_turn" },
      { chunks: ["Eleven strands."], stopReason: "end_turn" },
      { chunks: ["Inside the barrel."], stopReason: "end_turn" },
    ]);
    expect(harness.fake.conversations()).toEqual([
      {
        projectId,
        messages: ["What is the fold of GFP?", "How many strands?", "Where is the chromophore?"],
        status: "completed",
      },
    ]);
  });

  it("can be prompted again after a turn failed", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => turn.fail("The sandbox ran out of memory"));
    harness.fake.onNextMessage((turn) => {
      turn.replyText("Folded on the second try.");
      turn.complete();
    });

    const { firstTurn, secondTurn } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const firstTurn = await runTurn(session, "Fold this protein").catch(String);
      return { firstTurn, secondTurn: await runTurn(session, "Try again") };
    });

    expect(firstTurn).toMatch(/The sandbox ran out of memory/);
    // The fake daemon repeats the first turn's "failed" status just before the second turn
    // starts, as docs/protocol.md describes; that repeat must not end the second turn.
    expect(secondTurn).toEqual({ chunks: ["Folded on the second try."], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["Fold this protein", "Try again"], status: "completed" },
    ]);
  });

  it("refuses a prompt while the session's turn is still running, saying so", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const turnRunning = gate();
    const turnMayEnd = gate();
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Still folding.");
      turnRunning.open();
      await turnMayEnd.opened;
      turn.complete();
    });

    const { early, running } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      const running = runTurn(session, "Fold this protein");
      await turnRunning.opened;
      // Sent as a bare request: `session.prompt` would hand its failure to the running turn too.
      const early = await context
        .request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "And this one" }],
        })
        .catch(String);
      turnMayEnd.open();
      return { early, running: await running };
    });

    expect(early).toMatch(/still answering its previous prompt/);
    expect(running).toEqual({ chunks: ["Still folding."], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["Fold this protein"], status: "completed" },
    ]);
  });
});
