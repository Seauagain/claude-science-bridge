import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

describe("opening a session when the setup is wrong", () => {
  it("says to start the daemon when it is not running", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.reportRunning(false);

    const opening = harness.withClient((context) => context.buildSession(folder).start());

    await expect(opening).rejects.toThrow(/not running.*claude-science serve/s);
  });

  it("opens the session once the daemon has been started", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.reportRunning(false);

    const sessionId = await harness.withClient(async (context) => {
      await context
        .buildSession(folder)
        .start()
        .catch(() => {});
      harness.fake.reportRunning(true);
      return (await context.buildSession(folder).start()).sessionId;
    });

    expect(sessionId).not.toBe("");
  });

  it("names CLAUDE_SCIENCE_BIN when the Science CLI is missing", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const missingScienceCli = () => Promise.reject(new Error("spawn claude-science ENOENT"));

    const opening = harness.withClient((context) => context.buildSession(folder).start(), {
      scienceCli: missingScienceCli,
    });

    await expect(opening).rejects.toThrow(/claude-science.*CLAUDE_SCIENCE_BIN/s);
  });

  it("names the Science CLI call whose output does not have the expected shape", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const statusWithoutPort = (args: readonly string[]) =>
      args[0] === "status"
        ? Promise.resolve(JSON.stringify({ running: true, version: "0.1.53" }))
        : harness.fake.scienceCli(args);

    const opening = harness.withClient((context) => context.buildSession(folder).start(), {
      scienceCli: statusWithoutPort,
    });

    await expect(opening).rejects.toThrow(/"claude-science status".*"port"/s);
  });

  it("names the daemon call whose response does not have the expected shape", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.respondOnce("GET /api/me", { email: "researcher@example.org" });

    const opening = harness.withClient((context) => context.buildSession(folder).start());

    await expect(opening).rejects.toThrow(/"GET \/me".*"user_id"/s);
  });
});

describe("prompting when the daemon answers in an unexpected shape", () => {
  it("fails the prompt with an error that names the call", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    harness.fake.respondOnce(`POST /api/projects/${projectId}/request`, { status: "accepted" });

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Hello");
    });

    await expect(failure).rejects.toThrow(/"POST \/projects\/<id>\/request".*"root_frame_id"/s);
  });
});
