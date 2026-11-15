import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExistingMessage } from "../../science-daemon/testing.ts";
import { type Harness, startHarness } from "./support/harness.ts";
import { loadSession, replyText, userText } from "./support/loaded-session.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** Loads a conversation with the given transcript and returns the history that is replayed. */
async function replayOf(transcript: readonly ExistingMessage[]) {
  const { folder, projectId } = await harness.linkedFolder("Protein folding");
  const conversationId = harness.fake.addConversation(projectId, {
    title: "Fold of GFP",
    updatedAt: "2026-11-02T10:00:00Z",
    transcript,
  });
  const session = await harness.withClient((context) =>
    loadSession(harness, context, conversationId, folder),
  );
  return session.history;
}

describe("loading a listed conversation", () => {
  it("replays what the user typed and what Claude Science replied, in order, before it answers", async () => {
    const history = await replayOf([
      { role: "user", content: [{ type: "text", text: "What is the fold of GFP?" }] },
      { role: "assistant", content: [{ type: "text", text: "A beta barrel." }] },
      { role: "user", content: [{ type: "text", text: "How many strands?" }] },
      { role: "assistant", content: [{ type: "text", text: "Eleven." }] },
    ]);

    expect(history).toEqual([
      userText("What is the fold of GFP?"),
      replyText("A beta barrel."),
      userText("How many strands?"),
      replyText("Eleven."),
    ]);
  });

  it("replays a user message whose content is a plain string like one made of blocks", async () => {
    const history = await replayOf([
      { role: "user", content: "What is the fold of GFP?" },
      { role: "assistant", content: [{ type: "text", text: "A beta barrel." }] },
    ]);

    expect(history).toEqual([userText("What is the fold of GFP?"), replyText("A beta barrel.")]);
  });

  it("leaves out the messages the daemon added itself", async () => {
    const history = await replayOf([
      {
        role: "user",
        content: [{ type: "text", text: "Compute snapshot: 4 CPUs, 16 GB of memory." }],
        harnessNotice: true,
      },
      { role: "user", content: [{ type: "text", text: "What is the fold of GFP?" }] },
      { role: "user", content: "Skill hint: structure-lookup is available.", harnessNotice: true },
      { role: "assistant", content: [{ type: "text", text: "A beta barrel." }] },
    ]);

    expect(history).toEqual([userText("What is the fold of GFP?"), replyText("A beta barrel.")]);
  });

  it("replays each tool use as a completed tool call, titled with what the tool was doing", async () => {
    const history = await replayOf([
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
    ]);

    expect(history).toEqual([
      userText("What is the fold of GFP?"),
      replyText("Let me look it up."),
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_lookup",
        title: "Searching the structure database for GFP",
        status: "completed",
      },
      replyText("A beta barrel."),
    ]);
  });

  it("titles a tool call with the tool's name when the tool use has no description", async () => {
    const history = await replayOf([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_render", name: "render_structure", input: { id: "1EMA" } },
        ],
      },
    ]);

    expect(history).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_render",
        title: "render_structure",
        status: "completed",
      },
    ]);
  });

  it("leaves out reasoning, tool results and images", async () => {
    const history = await replayOf([
      {
        role: "user",
        content: [
          { type: "text", text: "What does this gel show?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user sent a picture of a gel." },
          { type: "tool_use", id: "toolu_gel", name: "read_image", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_gel", content: "Two bands." }],
      },
      { role: "assistant", content: [{ type: "text", text: "Two bands, near 27 kDa." }] },
    ]);

    expect(history).toEqual([
      userText("What does this gel show?"),
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_gel",
        title: "read_image",
        status: "completed",
      },
      replyText("Two bands, near 27 kDa."),
    ]);
  });

  it("replays a history longer than one page of the transcript completely", async () => {
    const transcript: ExistingMessage[] = [];
    for (let exchange = 1; exchange <= 130; exchange++) {
      transcript.push({ role: "user", content: `Question ${exchange}` });
      transcript.push({
        role: "assistant",
        content: [{ type: "text", text: `Answer ${exchange}` }],
      });
    }

    const history = await replayOf(transcript);

    expect(history).toHaveLength(260);
    expect(history.slice(0, 2)).toEqual([userText("Question 1"), replyText("Answer 1")]);
    expect(history.slice(198, 202)).toEqual([
      userText("Question 100"),
      replyText("Answer 100"),
      userText("Question 101"),
      replyText("Answer 101"),
    ]);
    expect(history.slice(-2)).toEqual([userText("Question 130"), replyText("Answer 130")]);
  });

  it("replays nothing for a conversation without messages", async () => {
    expect(await replayOf([])).toEqual([]);
  });
});

describe("loading an identifier that is neither a session nor a conversation", () => {
  it("fails with session not found", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const loading = harness.withClient((context) =>
      loadSession(harness, context, "0b9f4c1e-7a52-4d0e-9a3b-5f2d8c6e1a47", folder),
    );

    await expect(loading).rejects.toMatchObject({
      code: -32002,
      data: { sessionId: "0b9f4c1e-7a52-4d0e-9a3b-5f2d8c6e1a47" },
    });
  });
});
