import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectLink } from "../../project-link/index.ts";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** Opens a session in `folder` and sends one prompt. Resolves with the session's identifier. */
function promptIn(folder: string, prompt: string): Promise<string> {
  return harness.withClient(async (context) => {
    const session = await context.buildSession(folder).start();
    await runTurn(session, prompt);
    return session.sessionId;
  });
}

/** The text of the thoughts among a session's updates. */
function thoughts(updates: readonly SessionUpdate[]): string[] {
  return updates.flatMap((update) =>
    update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text"
      ? [update.content.text]
      : [],
  );
}

describe("the first prompt of a session whose folder is not linked to a project", () => {
  it("goes to the one project that has the folder's name, and links the folder to it", async () => {
    harness.fake.addProject("Membrane transport");
    const projectId = harness.fake.addProject("Protein folding");
    const folder = await harness.unlinkedFolder("Protein folding");

    await promptIn(folder, "What is the fold of GFP?");

    expect(harness.fake.conversations()).toEqual([
      { projectId, messages: ["What is the fold of GFP?"], status: "completed" },
    ]);
    expect(await findProjectLink(folder)).toEqual({ projectId, name: "Protein folding", folder });
    expect(harness.fake.projects().map((project) => project.name)).toEqual([
      "Membrane transport",
      "Protein folding",
    ]);
  });

  it("takes a project whose name differs from the folder's only in case", async () => {
    const projectId = harness.fake.addProject("Protein Folding");
    const folder = await harness.unlinkedFolder("protein folding");

    await promptIn(folder, "What is the fold of GFP?");

    expect(await findProjectLink(folder)).toEqual({ projectId, name: "Protein Folding", folder });
    expect(harness.fake.projects()).toHaveLength(1);
  });

  it("creates a project with the folder's name when there is none, and links the folder to it", async () => {
    harness.fake.addProject("Membrane transport");
    const folder = await harness.unlinkedFolder("Kinase screen");

    await promptIn(folder, "Which kinases bind this compound?");

    const created = harness.fake.projects()[1];
    expect(created).toMatchObject({ name: "Kinase screen", archived: false });
    expect(harness.fake.projects()).toHaveLength(2);
    expect(harness.fake.conversations()).toEqual([
      {
        projectId: created?.projectId,
        messages: ["Which kinases bind this compound?"],
        status: "completed",
      },
    ]);
    expect(await findProjectLink(folder)).toEqual({
      projectId: created?.projectId,
      name: "Kinase screen",
      folder,
    });
  });

  it("creates a project when the only one with the folder's name is archived", async () => {
    const archived = harness.fake.addProject("Kinase screen", { archived: true });
    const folder = await harness.unlinkedFolder("Kinase screen");

    await promptIn(folder, "Which kinases bind this compound?");

    const link = await findProjectLink(folder);
    expect(link?.projectId).not.toBe(archived);
    expect(harness.fake.projects().map((project) => project.archived)).toEqual([true, false]);
  });

  it("tells the client once, before the reply, that it linked the folder", async () => {
    harness.fake.addProject("Protein folding");
    const folder = await harness.unlinkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("A beta barrel.");
      turn.complete();
    });

    const updates = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "What is the fold of GFP?");
      await runTurn(session, "How many strands?");
      return harness.updates(session.sessionId);
    });

    expect(updates).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: 'Linked this folder to the Claude Science project "Protein folding".',
        },
      },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A beta barrel." } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
    ]);
  });

  it("tells the client that it created the project", async () => {
    const folder = await harness.unlinkedFolder("Kinase screen");

    const sessionId = await promptIn(folder, "Which kinases bind this compound?");

    expect(thoughts(harness.updates(sessionId))).toEqual([
      'Created the Claude Science project "Kinase screen" and linked this folder to it.',
    ]);
  });

  it("fails when several projects have the folder's name, saying how to link the folder", async () => {
    const one = harness.fake.addProject("Protein folding");
    const other = harness.fake.addProject("Protein folding");
    const folder = await harness.unlinkedFolder("Protein folding");

    const failure = promptIn(folder, "What is the fold of GFP?");

    await expect(failure).rejects.toThrow(/Several .*"Protein folding".*csbridge link --project/s);
    await expect(failure).rejects.toThrow(new RegExp(`${one}.*${other}`, "s"));
    expect(harness.fake.projects()).toHaveLength(2);
    expect(harness.fake.conversations()).toEqual([]);
    expect(await findProjectLink(folder)).toBeUndefined();
  });

  it("fails for a folder without a name, saying how to link it", async () => {
    harness.fake.addProject("Protein folding");
    const root = parse(tmpdir()).root;

    const failure = promptIn(root, "What is the fold of GFP?");

    await expect(failure).rejects.toThrow(/has no name.*csbridge link --project/s);
    expect(harness.fake.projects()).toHaveLength(1);
    expect(harness.fake.conversations()).toEqual([]);
  });

  it("says so when the link cannot be written, and sends nothing", async () => {
    harness.fake.addProject("Protein folding");
    const file = join(await harness.unlinkedFolder(), "notes.txt");
    await writeFile(file, "", "utf8");

    const failure = promptIn(join(file, "Protein folding"), "What is the fold of GFP?");

    await expect(failure).rejects.toThrow(/Could not link .*Protein folding.*Nothing was sent/s);
    expect(harness.fake.conversations()).toEqual([]);
  });
});

describe("two sessions that send their first prompt in the same unlinked folder at once", () => {
  it("end up in one project, which is created once", async () => {
    const folder = await harness.unlinkedFolder("Kinase screen");

    await harness.withClient(async (context) => {
      const one = await context.buildSession(folder).start();
      const other = await context.buildSession(folder).start();
      await Promise.all([runTurn(one, "First question"), runTurn(other, "Second question")]);
    });

    const projects = harness.fake.projects();
    expect(projects.map((project) => project.name)).toEqual(["Kinase screen"]);
    const conversations = harness.fake.conversations();
    expect(conversations.map((conversation) => conversation.projectId)).toEqual([
      projects[0]?.projectId,
      projects[0]?.projectId,
    ]);
    expect(conversations.flatMap((conversation) => conversation.messages).toSorted()).toEqual([
      "First question",
      "Second question",
    ]);
  });
});

describe("a session in a folder that an earlier prompt linked", () => {
  it("finds the link, in the folder and below it, and is told nothing about linking", async () => {
    const folder = await harness.unlinkedFolder("Kinase screen");
    await promptIn(folder, "Which kinases bind this compound?");
    const below = join(folder, "analysis", "figures");
    await mkdir(below, { recursive: true });

    const inFolder = await promptIn(folder, "From the folder");
    const fromBelow = await promptIn(below, "From below");

    const [project] = harness.fake.projects();
    expect(harness.fake.projects()).toHaveLength(1);
    expect(harness.fake.conversations().map((conversation) => conversation.projectId)).toEqual([
      project?.projectId,
      project?.projectId,
      project?.projectId,
    ]);
    expect(thoughts(harness.updates(inFolder))).toEqual([]);
    expect(thoughts(harness.updates(fromBelow))).toEqual([]);
  });
});

describe("a session in a folder that was linked before", () => {
  it("is told nothing about linking", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const sessionId = await promptIn(folder, "What is the fold of GFP?");

    expect(thoughts(harness.updates(sessionId))).toEqual([]);
  });
});
