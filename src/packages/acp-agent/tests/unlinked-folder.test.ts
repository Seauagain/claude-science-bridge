import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectLink } from "../../project-link/index.ts";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe("prompting a session whose folder is not linked to a project", () => {
  it("fails the prompt, saying how to link the folder, and sends nothing to the daemon", async () => {
    harness.fake.addProject("Protein folding");
    const folder = await harness.unlinkedFolder();

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "What is the fold of GFP?");
    });

    await expect(failure).rejects.toThrow(/not linked to a Claude Science project.*csbridge link/s);
    expect(harness.fake.conversations()).toEqual([]);
  });

  it("takes the prompt once the folder has been linked", async () => {
    const projectId = harness.fake.addProject("Protein folding");
    const folder = await harness.unlinkedFolder();

    const turn = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "What is the fold of GFP?").catch(() => {});
      await writeProjectLink(folder, { projectId, name: "Protein folding" });
      return runTurn(session, "What is the fold of GFP?");
    });

    expect(turn).toEqual({ chunks: ["pong"], stopReason: "end_turn" });
    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["What is the fold of GFP?"], status: "completed" },
    ]);
  });
});
