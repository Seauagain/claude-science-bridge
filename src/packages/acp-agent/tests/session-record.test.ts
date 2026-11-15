import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";
import { loadSession, replyText, userText } from "./support/loaded-session.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** Opens a session in `folder`, sends one prompt, and returns the session's identifier. */
function promptedSession(folder: string, prompt: string): Promise<string> {
  return harness.withClient(async (context) => {
    const session = await context.buildSession(folder).start();
    await runTurn(session, prompt);
    return session.sessionId;
  });
}

/** The history a new adapter process replays for a session. */
async function historyOf(sessionId: string, folder: string) {
  const session = await harness.withClient((context) =>
    loadSession(harness, context, sessionId, folder),
  );
  return session.history;
}

describe("the record of which session belongs to which conversation", () => {
  it("keeps every session when several adapter processes record one at the same time", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const questions = Array.from({ length: 12 }, (_, index) => `Question ${index + 1}`);

    const sessionIds = await Promise.all(
      questions.map((question) => promptedSession(folder, question)),
    );

    const histories = [];
    for (const sessionId of sessionIds) histories.push(await historyOf(sessionId, folder));
    expect(histories).toEqual(questions.map((question) => [userText(question), replyText("pong")]));
  });

  it("holds no message text", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage((turn) => {
      turn.replyText("A beta barrel.");
      turn.complete();
    });
    await promptedSession(folder, "What is the fold of GFP?");

    const files = await readdir(harness.stateFolder, { recursive: true, withFileTypes: true });
    const contents = await Promise.all(
      files
        .filter((entry) => entry.isFile())
        .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
    );
    expect(contents).not.toEqual([]);
    for (const text of contents) {
      expect(text).not.toMatch(/fold of GFP|beta barrel|Protein folding/);
    }
  });

  it("writes nothing for a session that is never prompted", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient((context) => context.buildSession(folder).start());

    await expect(readdir(harness.stateFolder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the other sessions when one of its lines cannot be read", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const before = await promptedSession(folder, "Question before");
    for (const name of await readdir(harness.stateFolder)) {
      await appendFile(join(harness.stateFolder, name), '{"sessionId":"3f0c\n[]\n', "utf8");
    }
    const after = await promptedSession(folder, "Question after");

    expect(await historyOf(before, folder)).toEqual([
      userText("Question before"),
      replyText("pong"),
    ]);
    expect(await historyOf(after, folder)).toEqual([userText("Question after"), replyText("pong")]);
  });
});

describe("a state folder that cannot be used", () => {
  /** A path that cannot be a folder, because a file is in the way. */
  async function blockedStateFolder(): Promise<string> {
    const blocker = join(await harness.temporaryFolder(), "not-a-folder");
    await writeFile(blocker, "", "utf8");
    return join(blocker, "state");
  }

  it("fails the first prompt, saying that the session could not be recorded and where", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const stateFolder = await blockedStateFolder();

    const failure = harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "What is the fold of GFP?");
      },
      { stateFolder },
    );

    await expect(failure).rejects.toThrow(/could not record this session in .*not-a-folder/);
    // The message had been sent by then, as the error says.
    expect(harness.fake.conversations()).toMatchObject([
      { projectId, messages: ["What is the fold of GFP?"] },
    ]);
  });

  it("fails listing sessions, saying that the record cannot be read and where", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const stateFolder = await blockedStateFolder();

    const listing = harness.withClient(
      (context) => context.request(methods.agent.session.list, { cwd: folder }),
      { stateFolder },
    );

    await expect(listing).rejects.toThrow(/cannot read its session record .*not-a-folder/);
  });
});
