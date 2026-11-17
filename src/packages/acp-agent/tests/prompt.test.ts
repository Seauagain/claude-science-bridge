import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectLink } from "../../project-link/index.ts";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";
import { heldMessage } from "./support/held-message.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe("prompting a session", () => {
  it("streams the reply as message chunks and ends the turn", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("The structure ");
      turn.replyText("is a beta barrel.");
      turn.complete();
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "What is the fold of GFP?");
    });

    expect(chunks).toEqual(["The structure ", "is a beta barrel."]);
    expect(stopReason).toBe("end_turn");
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["What is the fold of GFP?"], status: "completed" },
    ]);
  });

  it("does not pass reasoning text on as reply text", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.reasoningText("The user asks about GFP. ");
      turn.replyText("A beta barrel.");
      turn.reasoningText("That answers it.");
      turn.complete();
    });

    const turn = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "What is the fold of GFP?");
    });

    expect(turn).toEqual({ chunks: ["A beta barrel."], stopReason: "end_turn" });
  });

  it("leaves out empty pieces of reply text", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("");
      turn.replyText("A beta barrel.");
      turn.replyText("");
      turn.complete();
    });

    const turn = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "What is the fold of GFP?");
    });

    expect(turn).toEqual({ chunks: ["A beta barrel."], stopReason: "end_turn" });
  });

  it("ignores events of other conversations and of sub-agent frames", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      const elsewhere = { root_frame_id: "another-conversation", frame_id: "another-conversation" };
      turn.replyText("Mine. ");
      harness.fake.broadcast({
        type: "text_chunk",
        ...elsewhere,
        block_type: "text",
        chunk: "NOT MINE",
      });
      harness.fake.broadcast({ type: "frame_update", ...elsewhere, status: "processing" });
      harness.fake.broadcast({ type: "frame_update", ...elsewhere, status: "completed" });
      harness.fake.broadcast({
        type: "text_chunk",
        root_frame_id: turn.conversationId,
        frame_id: "a-sub-agent-frame",
        block_type: "text",
        chunk: "SUB-AGENT",
      });
      turn.replyText("Still mine.");
      turn.complete();
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Hello");
    });

    expect(chunks).toEqual(["Mine. ", "Still mine."]);
    expect(stopReason).toBe("end_turn");
  });

  it("follows a turn whose message was accepted only after a flood of unrelated events", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const message = heldMessage(harness.fake);

    const turn = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        message.holdNextMessage();
        const turn = runTurn(session, "ping");
        await message.onItsWay;
        // The user's other activity, on the one socket that also carries this turn's events.
        for (let event = 0; event < 1500; event++) {
          harness.fake.broadcast({ type: "kernel_stats", cpu_percent: event % 100 });
        }
        message.release();
        return turn;
      },
      { scienceCli: message.scienceCli },
    );

    expect(turn).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
  });

  it("reports a turn that failed on the daemon, naming the cause", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("Starting");
      turn.fail("The sandbox ran out of memory");
    });

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Fold this protein");
    });

    await expect(failure).rejects.toThrow(/The sandbox ran out of memory/);
  });

  it("reports a message the daemon refuses, with the daemon's reason", async () => {
    const folder = await harness.unlinkedFolder();
    await writeProjectLink(folder, { projectId: "proj_deleted00000", name: "Deleted long ago" });

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Hello");
    });

    await expect(failure).rejects.toThrow(
      /Claude Science refused .*Project proj_deleted00000 not found/,
    );
  });

  it("refuses prompt content it cannot pass on, naming the kind of content", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt({ type: "audio", data: "AAAA", mimeType: "audio/wav" });
    });

    await expect(failure).rejects.toThrow(/take text, images and files.*"audio"/);
    expect(harness.fake.conversations()).toEqual([]);
  });

  it("sends linked resources as their address", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt([
        { type: "text", text: "Summarise this file:" },
        { type: "resource_link", uri: "file:///data/screen.csv", name: "screen.csv" },
      ]);
    });

    expect(harness.fake.conversations()[0]?.messages).toEqual([
      "Summarise this file:\nfile:///data/screen.csv",
    ]);
  });
});
