import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectLink } from "../../project-link/index.ts";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../science-daemon/testing.ts";
import { acpClient } from "./support/acp-client.ts";
import { startCli } from "./support/cli.ts";

let fake: FakeScienceDaemon;
/** A temporary folder that holds everything a test creates. */
let scratch: string;
/** A folder linked to a project. */
let folder: string;
let homeFolder: string;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
  scratch = await mkdtemp(join(tmpdir(), "csbridge-state-"));
  folder = join(scratch, "folding");
  homeFolder = join(scratch, "home");
  await writeProjectLink(folder, {
    projectId: fake.addProject("Protein folding"),
    name: "Protein folding",
  });
});

afterEach(async () => {
  await fake.close();
  await rm(scratch, { recursive: true, force: true });
});

/** Runs `csbridge acp` for one client that opens a session, sends one prompt and disconnects. */
async function promptedSession(env: Record<string, string>): Promise<string> {
  const adapter = startCli(["acp"], { scienceCli: fake.scienceCli, env, homeFolder });
  const client = acpClient(adapter);
  await client.initialize();
  const sessionId = await client.openSession(folder);
  await client.prompt(sessionId, "What is the fold of GFP?");
  adapter.stdin.end();
  await adapter.exitCode;
  return sessionId;
}

/** Whether a `csbridge acp` started anew can load the session. */
async function loadsInANewProcess(sessionId: string, env: Record<string, string>) {
  const adapter = startCli(["acp"], { scienceCli: fake.scienceCli, env, homeFolder });
  const client = acpClient(adapter);
  await client.initialize();
  const outcome = await client.loadSession(sessionId, folder).then(
    () => "loaded",
    (error: unknown) => String(error),
  );
  adapter.stdin.end();
  await adapter.exitCode;
  return outcome;
}

describe("where csbridge acp keeps its state", () => {
  it("is .csbridge in the home folder by default", async () => {
    await promptedSession({});

    expect(await readdir(join(homeFolder, ".csbridge"))).not.toEqual([]);
  });

  it("is the folder CSBRIDGE_STATE_DIR names, and then nothing is written to the home folder", async () => {
    const stateFolder = join(scratch, "elsewhere");

    await promptedSession({ CSBRIDGE_STATE_DIR: stateFolder });

    expect(await readdir(stateFolder)).not.toEqual([]);
    await expect(readdir(homeFolder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets a csbridge acp started later load the session", async () => {
    const sessionId = await promptedSession({});

    expect(await loadsInANewProcess(sessionId, {})).toBe("loaded");
  });

  it("does not find the session in another state folder", async () => {
    const sessionId = await promptedSession({});

    const outcome = await loadsInANewProcess(sessionId, {
      CSBRIDGE_STATE_DIR: join(scratch, "elsewhere"),
    });

    expect(outcome).toMatch(/Resource not found/);
  });
});
