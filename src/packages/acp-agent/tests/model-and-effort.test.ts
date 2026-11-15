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
        id: "model",
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
      return choose(context, sessionId, "model", "model-small");
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
      return choose(context, sessionId, "model", "model-basic");
    });

    expect(summary(changed.configOptions).map((option) => option.id)).toEqual(["model"]);
  });

  it("refuse a model the daemon does not offer, naming the ones it does", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const failure = harness.withClient(async (context) => {
      const { sessionId } = await openSession(context, folder);
      return choose(context, sessionId, "model", "model-imaginary");
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
      await choose(context, sessionId, "model", "model-small");
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
      await choose(context, sessionId, "model", "model-small");
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
      { id: "model", current: "model-small" },
      { id: "effort", current: "low" },
    ]);
  });
});

// T3 Code refuses a change of model on a thread that has no session bound to it, which is every
// thread that was settled or only imported. It takes a change of any other option at any time.
describe("the model, for T3 Code", () => {
  it.each(["t3-code", "t3-code-provider-test", "t3-code-session-manager"])(
    "is an option like any other for the client %s, so that it can always be changed",
    async (clientName) => {
      const { folder } = await harness.linkedFolder("Protein folding");

      const opened = await harness.withClient((context) => openSession(context, folder), {
        clientName,
      });

      expect(summary(opened.configOptions)).toEqual([
        {
          id: "model",
          category: undefined,
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
    },
  );

  it("is chosen the same way, and stays a plain option in what is sent back", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const changed = await harness.withClient(
      async (context) => {
        const { sessionId } = await openSession(context, folder);
        const answer = await choose(context, sessionId, "model", "model-small");
        await prompt(context, sessionId, "What is the fold of GFP?");
        return answer;
      },
      { clientName: "t3-code" },
    );

    expect(summary(changed.configOptions)[0]).toMatchObject({
      id: "model",
      category: undefined,
      current: "model-small",
    });
    expect(harness.fake.conversationSettings()[0]?.model).toBe("model-small");
  });

  it("is a plain option for a conversation that is loaded, too", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const conversationId = harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
      model: "model-small",
      effort: "low",
    });

    const loaded = await harness.withClient(
      (context) =>
        context.request(methods.agent.session.load, {
          sessionId: conversationId,
          cwd: folder,
          mcpServers: [],
        }),
      { clientName: "t3-code" },
    );

    expect(summary(loaded?.configOptions)[0]).toMatchObject({
      id: "model",
      category: undefined,
      current: "model-small",
    });
  });
});
