import { methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** A project with one conversation about GFP, and a folder linked to the project. */
async function projectWithConversation() {
  const { folder, projectId } = await harness.linkedFolder("Protein folding");
  const conversationId = harness.fake.addConversation(projectId, {
    title: "Fold of GFP",
    updatedAt: "2026-11-02T10:00:00Z",
    transcript: [
      { role: "user", content: [{ type: "text", text: "What is the fold of GFP?" }] },
      { role: "assistant", content: [{ type: "text", text: "A beta barrel." }] },
    ],
  });
  return { folder, conversationId };
}

describe("the /open command, in a session that has no conversation yet", () => {
  it("shows the conversation's earlier messages and sends nothing to the daemon", async () => {
    const { folder, conversationId } = await projectWithConversation();

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, `/open ${conversationId}`);
    });

    expect(chunks.join("")).toBe(
      ["**You**", "What is the fold of GFP?", "**Claude Science**", "A beta barrel.", ""].join(
        "\n\n",
      ),
    );
    expect(stopReason).toBe("end_turn");
    expect(harness.fake.conversations().flatMap((conversation) => conversation.messages)).toEqual(
      [],
    );
  });

  it("tells the client the model and effort the conversation has", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const conversationId = harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
      model: "model-small",
      effort: "low",
    });

    const updates = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, `/open ${conversationId}`);
      return harness.updates(session.sessionId);
    });

    const reported = updates.flatMap((update) =>
      update.sessionUpdate === "config_option_update" ? [update.configOptions] : [],
    );
    expect(reported).toHaveLength(1);
    expect(
      reported[0]?.map((option) => ({
        id: option.id,
        current: option.type === "select" ? option.currentValue : undefined,
      })),
    ).toEqual([
      { id: "model", current: "model-small" },
      { id: "effort", current: "low" },
    ]);
  });

  it("makes the session continue that conversation", async () => {
    const { folder, conversationId } = await projectWithConversation();

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, `/open ${conversationId}`);
      return runTurn(session, "How many strands?");
    });

    expect(harness.fake.conversations()).toHaveLength(1);
    expect(harness.fake.conversations()[0]?.messages).toEqual(["How many strands?"]);
  });

  it("takes the conversation off the list of sessions to import", async () => {
    const { folder, conversationId } = await projectWithConversation();

    const listed = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, `/open ${conversationId}`);
      return context.request(methods.agent.session.list, { cwd: folder });
    });

    expect(listed.sessions).toEqual([]);
  });

  it("fails for a conversation that does not exist, and leaves the session free to start one", async () => {
    const { folder } = await projectWithConversation();

    const stopReason = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await expect(runTurn(session, "/open no-such-conversation")).rejects.toThrow(
        /no conversation "no-such-conversation"/i,
      );
      return (await runTurn(session, "What is the fold of GFP?")).stopReason;
    });

    expect(stopReason).toBe("end_turn");
    expect(harness.fake.conversations()).toHaveLength(2);
  });
});

describe("the /open command, in a session that has a conversation", () => {
  it("is refused, saying that a thread holds one conversation", async () => {
    const { folder, conversationId } = await projectWithConversation();

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Hello");
      return runTurn(session, `/open ${conversationId}`);
    });

    await expect(failure).rejects.toThrow(/already has a conversation/);
  });
});
