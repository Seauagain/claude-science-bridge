import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";
import { loadSession } from "./support/loaded-session.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** A project with one conversation about GFP that used a tool, and a folder linked to it. */
async function projectWithConversation() {
  const { folder, projectId } = await harness.linkedFolder("Protein folding");
  const conversationId = harness.fake.addConversation(projectId, {
    title: "Fold of GFP",
    updatedAt: "2026-11-02T10:00:00Z",
    transcript: [
      { role: "user", content: [{ type: "text", text: "What is the fold of GFP?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look it up." },
          {
            type: "tool_use",
            id: "toolu_lookup",
            name: "search_structures",
            input: { query: "GFP", human_description: "Searching the structure database for GFP" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "A beta barrel." }] },
      { role: "user", content: "How many strands?" },
      { role: "assistant", content: [{ type: "text", text: "Eleven." }] },
    ],
  });
  return { folder, conversationId };
}

describe("the /history command", () => {
  it("shows the conversation's earlier messages, each speaker under a heading, in order", async () => {
    const { folder, conversationId } = await projectWithConversation();

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await loadSession(harness, context, conversationId, folder);
      return session.runTurn("/history");
    });

    expect(chunks.join("")).toBe(
      [
        "**You**",
        "What is the fold of GFP?",
        "**Claude Science**",
        "Let me look it up.",
        "_Tool: Searching the structure database for GFP_",
        "A beta barrel.",
        "**You**",
        "How many strands?",
        "**Claude Science**",
        "Eleven.",
        "",
      ].join("\n\n"),
    );
    expect(stopReason).toBe("end_turn");
  });

  it("sends nothing to the daemon", async () => {
    const { folder, conversationId } = await projectWithConversation();

    await harness.withClient(async (context) => {
      const session = await loadSession(harness, context, conversationId, folder);
      return session.runTurn("  /history \n");
    });

    expect(harness.fake.conversations().flatMap((conversation) => conversation.messages)).toEqual(
      [],
    );
  });

  it("says so when the thread has no earlier messages, and starts no conversation", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "/history");
    });

    expect(chunks).toEqual(["This thread has no earlier messages."]);
    expect(stopReason).toBe("end_turn");
    expect(harness.fake.conversations()).toEqual([]);
  });

  it("is not triggered by a prompt that merely mentions it", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "What does /history do?");
    });

    expect(harness.fake.conversations()[0]?.messages).toEqual(["What does /history do?"]);
  });
});

describe("the commands a session offers", () => {
  const offersHistory = expect.arrayContaining([
    expect.objectContaining({
      sessionUpdate: "available_commands_update",
      availableCommands: [expect.objectContaining({ name: "history" })],
    }),
  ]);

  it("include /history for a session the client opens", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const updates = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return harness.updates(session.sessionId);
    });

    expect(updates).toEqual(offersHistory);
  });

  it("include /history for a session the client loads", async () => {
    const { folder, conversationId } = await projectWithConversation();

    const updates = await harness.withClient(async (context) => {
      await loadSession(harness, context, conversationId, folder);
      return harness.updates(conversationId);
    });

    expect(updates).toEqual(offersHistory);
  });
});
