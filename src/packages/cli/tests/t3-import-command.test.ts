import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectLink } from "../../project-link/index.ts";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../science-daemon/testing.ts";
import { runCommand } from "./support/cli.ts";

let fake: FakeScienceDaemon;
let folder: string;
let home: string;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
  folder = await mkdtemp(join(tmpdir(), "csbridge-t3-"));
  home = await mkdtemp(join(tmpdir(), "csbridge-t3-home-"));
});

afterEach(async () => {
  await fake.close();
  await rm(folder, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/**
 * A stand-in for the T3 Code command line. It writes down what it was asked and answers as the
 * real one does: nothing for an added project, a JSON list of threads, a JSON object for a
 * thread that was started.
 */
function t3StandIn(
  behaviour: { existingThreadIds?: string[]; refuse?: (args: string) => string | undefined } = {},
) {
  const calls: string[][] = [];
  const t3Cli = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    const refusal = behaviour.refuse?.(args.join(" "));
    if (refusal !== undefined) throw new Error(refusal);
    if (args[0] === "thread" && args[1] === "list") {
      return JSON.stringify((behaviour.existingThreadIds ?? []).map((threadId) => ({ threadId })));
    }
    if (args[0] === "thread" && args[1] === "start") {
      return JSON.stringify({ threadId: `thread-${calls.length}`, status: "completed" });
    }
    return "";
  };
  const started = () =>
    calls
      .filter((args) => args[0] === "thread" && args[1] === "start")
      .map((args) => ({
        title: args[args.indexOf("--title") + 1],
        provider: args[args.indexOf("--provider") + 1],
        model: args[args.indexOf("--model") + 1],
        folder: args.at(-2),
        message: args.at(-1),
      }));
  const addedProjects = () =>
    calls
      .filter((args) => args[0] === "project" && args[1] === "add")
      .map((args) => ({ title: args[args.indexOf("--title") + 1], folder: args.at(-1) }));
  return { t3Cli, started, addedProjects };
}

function importInto(t3Cli: (args: readonly string[]) => Promise<string>, argv: string[] = ["."]) {
  return runCommand(["t3-import", ...argv], {
    scienceCli: fake.scienceCli,
    cwd: folder,
    homeFolder: home,
    t3Cli,
  });
}

describe("csbridge t3-import", () => {
  it("starts a thread on the default model when the conversation's model is no longer offered", async () => {
    const folding = fake.addProject("Protein folding");
    fake.addConversation(folding, {
      title: "Fold of GFP",
      updatedAt: "2026-11-01T10:00:00Z",
      model: "model-retired",
    });
    const t3 = t3StandIn();

    const result = await importInto(t3.t3Cli);

    expect(result.exitCode).toBe(0);
    expect(t3.started().map((thread) => thread.model)).toEqual(["model-large"]);
  });

  it("gives every project a linked folder and a T3 project, and every conversation a thread that opens it", async () => {
    const folding = fake.addProject("Protein folding");
    const climate = fake.addProject("Climate model");
    const older = fake.addConversation(folding, {
      title: "Fold of GFP",
      updatedAt: "2026-11-01T10:00:00Z",
      model: "model-small",
    });
    const newer = fake.addConversation(folding, {
      title: "Beta barrels",
      updatedAt: "2026-11-02T10:00:00Z",
    });
    const t3 = t3StandIn();

    const result = await importInto(t3.t3Cli);

    expect(result.exitCode).toBe(0);
    expect((await findProjectLink(join(folder, "Protein folding")))?.projectId).toBe(folding);
    expect((await findProjectLink(join(folder, "Climate model")))?.projectId).toBe(climate);
    expect(t3.addedProjects()).toEqual([
      { title: "CS-Protein folding", folder: join(folder, "Protein folding") },
      { title: "CS-Climate model", folder: join(folder, "Climate model") },
    ]);
    // Oldest first, so that the newest conversation ends up as the most recent thread. Each
    // thread runs on the model its conversation has, or the daemon's default.
    expect(t3.started()).toEqual([
      {
        title: "Fold of GFP",
        provider: "claudeScience",
        model: "model-small",
        folder: join(folder, "Protein folding"),
        message: `/open ${older}`,
      },
      {
        title: "Beta barrels",
        provider: "claudeScience",
        model: "model-large",
        folder: join(folder, "Protein folding"),
        message: `/open ${newer}`,
      },
    ]);
    expect(result.stdout).toBe(
      "CS-Protein folding: 2 conversations brought in\nCS-Climate model: nothing to bring in\n",
    );
  });

  it("leaves out conversations that have a thread already, whichever way they got it", async () => {
    const folding = fake.addProject("Protein folding");
    const opened = fake.addConversation(folding, {
      title: "Opened before",
      updatedAt: "2026-11-01T10:00:00Z",
    });
    const native = fake.addConversation(folding, {
      title: "Imported by T3",
      updatedAt: "2026-11-02T10:00:00Z",
    });
    const fresh = fake.addConversation(folding, {
      title: "Not yet",
      updatedAt: "2026-11-03T10:00:00Z",
    });
    await mkdir(join(home, ".csbridge"), { recursive: true });
    await writeFile(
      join(home, ".csbridge", "sessions.jsonl"),
      `${JSON.stringify({ sessionId: "an-earlier-session", conversationId: opened })}\n`,
      "utf8",
    );
    const t3 = t3StandIn({
      existingThreadIds: [`thread:provider:acpRegistry:x:native-thread:${native}`],
    });

    const result = await importInto(t3.t3Cli);

    expect(t3.started().map((thread) => thread.message)).toEqual([`/open ${fresh}`]);
    expect(result.stdout).toBe("CS-Protein folding: 1 conversation brought in, 2 already there\n");
  });

  it("goes on when T3 has the project already", async () => {
    const folding = fake.addProject("Protein folding");
    fake.addConversation(folding, { title: "Fold of GFP", updatedAt: "2026-11-01T10:00:00Z" });
    const t3 = t3StandIn({
      refuse: (args) =>
        args.startsWith("project add")
          ? "ProjectAlreadyExistsError: An active project already exists"
          : undefined,
    });

    const result = await importInto(t3.t3Cli);

    expect(result.exitCode).toBe(0);
    expect(t3.started()).toHaveLength(1);
  });

  it("takes the provider and the title prefix it is told to use", async () => {
    const folding = fake.addProject("Protein folding");
    fake.addConversation(folding, { title: "Fold of GFP", updatedAt: "2026-11-01T10:00:00Z" });
    const t3 = t3StandIn();

    await importInto(t3.t3Cli, ["--provider", "science", "--prefix", "Sci / ", "."]);

    expect(t3.addedProjects()[0]?.title).toBe("Sci / Protein folding");
    expect(t3.started()[0]?.provider).toBe("science");
  });

  it("reports a thread that could not be started, goes on with the others, and fails", async () => {
    const folding = fake.addProject("Protein folding");
    const broken = fake.addConversation(folding, {
      title: "Breaks",
      updatedAt: "2026-11-01T10:00:00Z",
    });
    fake.addConversation(folding, { title: "Works", updatedAt: "2026-11-02T10:00:00Z" });
    const t3 = t3StandIn({
      refuse: (args) => (args.includes(broken) ? "the provider did not start" : undefined),
    });

    const result = await importInto(t3.t3Cli);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/"Breaks".*the provider did not start/);
    expect(result.stdout).toBe("CS-Protein folding: 1 conversation brought in, 1 failed\n");
  });

  it("says how to get the T3 command line when there is none", async () => {
    fake.addProject("Protein folding");

    const result = await runCommand(["t3-import", "."], {
      scienceCli: fake.scienceCli,
      cwd: folder,
      homeFolder: home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/t3.*command line/i);
  });

  it("needs a folder", async () => {
    const result = await importInto(t3StandIn().t3Cli, []);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/csbridge t3-import/);
  });
});
