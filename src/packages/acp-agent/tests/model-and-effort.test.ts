import { type ClientContext, methods, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** What a client shows of an option: its category, the current value, and the choices. */
function summary(options: readonly SessionConfigOption[] | null | undefined) {
  return (options ?? []).map((option) => ({
    id: option.id,
    category: option.category,
    current: option.type === "select" ? option.currentValue : undefined,
    choices:
      option.type === "select"
        ? option.options.map((choice) =>
            "value" in choice ? `${choice.value}=${choice.name}` : "",
          )
        : [],
  }));
}

async function openSession(context: ClientContext, folder: string) {
  return context.request(methods.agent.session.new, { cwd: folder, mcpServers: [] });
}

function choose(context: ClientContext, sessionId: string, configId: string, value: string) {
  return context.request(methods.agent.session.setConfigOption, { sessionId, configId, value });
}

function prompt(context: ClientContext, sessionId: string, text: string) {
  return context.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
  });
}

// The fake daemon offers three models: "model-large" (the default; efforts low, medium,
// high, max, of which medium is the default), "model-small" (low, which it recommends, and
// medium) and "model-basic" (no effort at all).
describe("the model and effort a session offers", () => {
  it("are the daemon's models, with the default model and its efforts selected", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const opened = await harness.withClient((context) => openSession(context, folder));

    expect(summary(opened.configOptions)).toEqual([
      {
        id: "claude_science_model",
        category: "model",
        current: "model-large",
        choices: ["model-large=Large", "model-small=Small", "model-basic=Basic"],
      },
      {
        id: "effort",
        category: "thought_level",
        current: "medium",
        choices: ["low=Low", "medium=Medium", "high=High", "max=Max"],
      },
    ]);
  });

  it("follow the chosen model: its own efforts, and its recommended one when the choice does not fit", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const changed = await harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      await choose(context, sessionId, "effort", "max");
      return choose(context, sessionId, "claude_science_model", "model-small");
    });

    expect(summary(changed.configOptions)[1]).toEqual({
      id: "effort",
      category: "thought_level",
      current: "low",
      choices: ["low=Low", "medium=Medium"],
    });
  });

  it("leave out the effort for a model that has none", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const changed = await harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      return choose(context, sessionId, "claude_science_model", "model-basic");
    });

    expect(summary(changed.configOptions).map((option) => option.id)).toEqual([
      "claude_science_model",
    ]);
  });

  it("refuse a model the daemon does not offer, naming the ones it does", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const failure = harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      return choose(context, sessionId, "claude_science_model", "model-imaginary");
    });

    await expect(failure).rejects.toThrow(
      /model-imaginary.*model-large, model-small, model-basic/s,
    );
  });
});

describe("a conversation", () => {
  it("starts with the model and effort that were chosen", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      await choose(context, sessionId, "claude_science_model", "model-small");
      await choose(context, sessionId, "effort", "medium");
      return prompt(context, sessionId, "What is the fold of GFP?");
    });

    expect(harness.fake.conversationSettings()).toEqual([
      { model: "model-small", effort: "medium" },
    ]);
  });

  it("starts with the default model and effort when nothing was chosen", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      return prompt(context, sessionId, "What is the fold of GFP?");
    });

    expect(harness.fake.conversationSettings()).toEqual([
      { model: "model-large", effort: "medium" },
    ]);
  });

  it("takes a new model for its later messages", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      await prompt(context, sessionId, "What is the fold of GFP?");
      await choose(context, sessionId, "claude_science_model", "model-small");
      return prompt(context, sessionId, "How many strands?");
    });

    expect(harness.fake.conversationSettings()[0]?.model).toBe("model-small");
  });

  it("keeps the effort it started with: the daemon does not change it afterwards", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const changed = await harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      await prompt(context, sessionId, "What is the fold of GFP?");
      return choose(context, sessionId, "effort", "high");
    });

    // The client is shown what holds, not what it asked for.
    expect(summary(changed.configOptions)[1]?.current).toBe("medium");
    expect(harness.fake.conversationSettings()).toEqual([
      { model: "model-large", effort: "medium" },
    ]);
  });
});

describe("a conversation that is loaded", () => {
  it("shows the model and effort it has", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const conversationId = harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
      model: "model-small",
      effort: "low",
    });

    const loaded = await harness.withClient((context) =>
      context.request(methods.agent.session.load, {
        sessionId: conversationId,
        cwd: folder,
        mcpServers: [],
      }),
    );

    expect(summary(loaded?.configOptions).map(({ id, current }) => ({ id, current }))).toEqual([
      { id: "claude_science_model", current: "model-small" },
      { id: "effort", current: "low" },
    ]);
  });
});

describe("the model option", () => {
  // T3 Code keeps a thread's option choices by identifier and sends them again after it has
  // applied the thread's model. A version of csbridge that was never released offered T3 Code
  // a plain option called "model"; a choice left over from it must not override the model.
  it('is not called "model", and a choice made under that name is refused', async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const failure = harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      return choose(context, sessionId, "model", "model-small");
    });

    await expect(failure).rejects.toThrow(/no option "model"/);
  });
});
