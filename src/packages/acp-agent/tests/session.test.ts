import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
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

  it("refuses a folder that is not linked, saying how to link it", async () => {
    const folder = await harness.unlinkedFolder();

    const opening = harness.withClient((context) => context.buildSession(folder).start());

    await expect(opening).rejects.toThrow(/not linked to a Claude Science project.*csbridge link/s);
  });

  it("does not start a conversation until a prompt is sent", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient((context) => context.buildSession(folder).start());

    expect(harness.fake.conversations()).toEqual([]);
  });
});
