import { methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe("listing the sessions of a folder", () => {
  it("lists the conversations of the project the folder is linked to, newest first", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const oldest = harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-01T09:00:00Z",
    });
    const newest = harness.fake.addConversation(projectId, {
      title: "Kinase inhibitor screen",
      updatedAt: "2026-11-12T16:30:00Z",
    });
    const middle = harness.fake.addConversation(projectId, {
      title: "Docking run",
      updatedAt: "2026-11-05T11:15:00Z",
    });

    const response = await harness.withClient((context) =>
      context.request(methods.agent.session.list, { cwd: folder }),
    );

    expect(response).toEqual({
      sessions: [
        {
          sessionId: newest,
          cwd: folder,
          title: "Kinase inhibitor screen",
          updatedAt: "2026-11-12T16:30:00Z",
        },
        { sessionId: middle, cwd: folder, title: "Docking run", updatedAt: "2026-11-05T11:15:00Z" },
        { sessionId: oldest, cwd: folder, title: "Fold of GFP", updatedAt: "2026-11-01T09:00:00Z" },
      ],
    });
  });

  it("leaves out hidden conversations and frames that are not conversations the user sees", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.addConversation(projectId, {
      title: "Scratch work",
      updatedAt: "2026-11-03T10:00:00Z",
      hidden: true,
    });
    const visible = harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
    });
    harness.fake.addConversation(projectId, {
      title: "Uploaded files",
      updatedAt: "2026-11-01T10:00:00Z",
      conversationType: "uploads",
    });

    const response = await harness.withClient((context) =>
      context.request(methods.agent.session.list, { cwd: folder }),
    );

    expect(response.sessions.map((session) => session.sessionId)).toEqual([visible]);
  });

  it("leaves out the conversations of other projects", async () => {
    const folding = await harness.linkedFolder("Protein folding");
    const membranes = await harness.linkedFolder("Membrane transport");
    harness.fake.addConversation(folding.projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
    });
    const ionChannels = harness.fake.addConversation(membranes.projectId, {
      title: "Ion channels",
      updatedAt: "2026-11-01T10:00:00Z",
    });

    const response = await harness.withClient((context) =>
      context.request(methods.agent.session.list, { cwd: membranes.folder }),
    );

    expect(response.sessions.map((session) => session.sessionId)).toEqual([ionChannels]);
  });

  it("lists nothing for a folder that is not linked to a project", async () => {
    const projectId = harness.fake.addProject("Protein folding");
    harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
    });
    const folder = await harness.unlinkedFolder();

    const response = await harness.withClient((context) =>
      context.request(methods.agent.session.list, { cwd: folder }),
    );

    expect(response).toEqual({ sessions: [] });
  });

  it("lists nothing when the client names no folder", async () => {
    const { projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
    });

    const response = await harness.withClient((context) =>
      context.request(methods.agent.session.list, {}),
    );

    expect(response).toEqual({ sessions: [] });
  });
});
