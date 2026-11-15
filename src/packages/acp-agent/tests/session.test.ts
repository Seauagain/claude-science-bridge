import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectLink } from "../../project-link/index.ts";
import { type Harness, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe("initializing", () => {
  it("answers with the protocol version and only the capabilities it implements", async () => {
    const response = await harness.withClient((context) =>
      context.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    );

    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.agentInfo).toMatchObject({
      name: "claude-science-bridge",
      title: "Claude Science",
    });
    expect(response.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { list: {} },
    });
  });
});

describe("opening a session", () => {
  it("opens a session in a folder linked to a project", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const sessionId = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.sessionId;
    });

    expect(sessionId).not.toBe("");
  });

  it("opens a session in a folder that is not linked to a project, and leaves it unlinked", async () => {
    const folder = await harness.unlinkedFolder("Kinase screen");

    const sessionId = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.sessionId;
    });

    expect(sessionId).not.toBe("");
    expect(await findProjectLink(folder)).toBeUndefined();
    expect(harness.fake.projects()).toEqual([]);
  });

  it("does not start a conversation until a prompt is sent", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient((context) => context.buildSession(folder).start());

    expect(harness.fake.conversations()).toEqual([]);
  });
});
