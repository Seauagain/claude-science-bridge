import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  scratch = await mkdtemp(join(tmpdir(), "csbridge-attachments-"));
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

/** Saves a file the way T3 Code does in the home folder `t3Home`, and returns its line. */
async function savedByT3Code(t3Home: string): Promise<string> {
  const attachments = join(t3Home, "userdata", "attachments");
  await mkdir(attachments, { recursive: true });
  const saved = join(attachments, "0f3a-screen.csv");
  await writeFile(saved, "well,signal\n");
  return `[Attached file "screen.csv" is saved at: ${saved}]`;
}

/** The names of the files `csbridge acp` hands the daemon for a prompt that is `line`. */
async function attached(line: string, env: Record<string, string>): Promise<string[]> {
  const adapter = startCli(["acp"], { scienceCli: fake.scienceCli, env, homeFolder });
  const client = acpClient(adapter);
  await client.initialize();
  await client.prompt(await client.openSession(folder), line);
  adapter.stdin.end();
  await adapter.exitCode;
  return fake.attachments().map(({ filename }) => filename);
}

describe("where csbridge acp reads the files T3 Code attached", () => {
  it("is T3 Code's attachment folder in .t3 in the home folder by default", async () => {
    const line = await savedByT3Code(join(homeFolder, ".t3"));

    expect(await attached(line, {})).toEqual(["screen.csv"]);
  });

  it("is the attachment folder in the home T3CODE_HOME names", async () => {
    const line = await savedByT3Code(join(scratch, "t3-elsewhere"));

    expect(await attached(line, { T3CODE_HOME: join(scratch, "t3-elsewhere") })).toEqual([
      "screen.csv",
    ]);
  });

  it("is no other folder", async () => {
    const line = await savedByT3Code(join(scratch, "t3-elsewhere"));

    expect(await attached(line, {})).toEqual([]);
  });
});
