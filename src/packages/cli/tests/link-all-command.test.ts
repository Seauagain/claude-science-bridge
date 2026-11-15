import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectLink } from "../../project-link/index.ts";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../science-daemon/testing.ts";
import { acpClient } from "./support/acp-client.ts";
import { runCommand, startCli } from "./support/cli.ts";

let fake: FakeScienceDaemon;
let folder: string;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
  folder = await mkdtemp(join(tmpdir(), "csbridge-cli-"));
});

afterEach(async () => {
  await fake.close();
  await rm(folder, { recursive: true, force: true });
});

function link(argv: string[], cwd = folder) {
  return runCommand(["link", ...argv], { scienceCli: fake.scienceCli, cwd });
}

/** What comes after the list when at least one folder can be used. */
function nextStep(parent: string): string {
  return `\nNext: add the folders above, which are in ${parent}, as projects in your ACP client.\n`;
}

/** What comes last on standard error when a project was skipped. */
const SKIPPED =
  "\nA skipped folder is left as it is. Move or rename it, then run this command again.\n";

describe("csbridge link --all", () => {
  it("creates a sub-folder named after each project, linked to it", async () => {
    const folding = fake.addProject("Protein folding");
    const climate = fake.addProject("Climate model");

    const result = await link(["--all", "."]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `created    Protein folding\ncreated    Climate model\n${nextStep(folder)}`,
      stderr: "",
    });
    expect(await findProjectLink(join(folder, "Protein folding"))).toEqual({
      projectId: folding,
      name: "Protein folding",
      folder: join(folder, "Protein folding"),
    });
    expect(await findProjectLink(join(folder, "Climate model"))).toEqual({
      projectId: climate,
      name: "Climate model",
      folder: join(folder, "Climate model"),
    });
  });

  it("creates the sub-folders in the folder given, resolved against the working folder", async () => {
    const projectId = fake.addProject("Protein folding");
    const projects = join(folder, "projects");
    await mkdir(projects);

    const result = await link(["projects", "--all"]);

    expect(result.stdout).toBe(`created    Protein folding\n${nextStep(projects)}`);
    expect((await findProjectLink(join(projects, "Protein folding")))?.projectId).toBe(projectId);
  });

  it("leaves out archived projects", async () => {
    fake.addProject("Finished study", { archived: true });
    fake.addProject("Climate model");

    const result = await link(["--all", "."]);

    expect(result.stdout).toBe(`created    Climate model\n${nextStep(folder)}`);
    expect(await readdir(folder)).toEqual(["Climate model"]);
  });

  it("names a folder so that it is valid on every system, and says which project it is", async () => {
    const draft = fake.addProject("RNA/DNA: draft?");
    const chinese = fake.addProject("蛋白质折叠");

    const result = await link(["--all", "."]);

    expect(result.stdout).toBe(
      'created    RNA_DNA_ draft_  (project "RNA/DNA: draft?")\n' +
        `created    蛋白质折叠\n${nextStep(folder)}`,
    );
    expect((await findProjectLink(join(folder, "RNA_DNA_ draft_")))?.projectId).toBe(draft);
    expect((await findProjectLink(join(folder, "蛋白质折叠")))?.projectId).toBe(chinese);
  });

  it("gives projects of the same name a folder each, told apart by the identifier", async () => {
    const first = fake.addProject("Protein folding");
    const second = fake.addProject("protein folding");

    const result = await link(["--all", "."]);

    expect(result.stdout).toBe(
      `created    Protein folding (${first})  (project "Protein folding")\n` +
        `created    protein folding (${second})  (project "protein folding")\n${nextStep(folder)}`,
    );
    expect((await findProjectLink(join(folder, `Protein folding (${first})`)))?.projectId).toBe(
      first,
    );
    expect((await findProjectLink(join(folder, `protein folding (${second})`)))?.projectId).toBe(
      second,
    );
  });
});

describe("a folder created by csbridge link --all", () => {
  it("puts the sessions opened in it in its project", async () => {
    const folding = fake.addProject("Protein folding");
    const climate = fake.addProject("Climate model");
    await link(["--all", "."]);

    const adapter = startCli(["acp"], fake);
    const client = acpClient(adapter);
    await client.initialize();
    await client.prompt(await client.openSession(join(folder, "Climate model")), "about climate");
    await client.prompt(await client.openSession(join(folder, "Protein folding")), "about folds");
    adapter.stdin.end();
    await adapter.exitCode;

    expect(fake.conversations()).toEqual([
      { projectId: climate, messages: ["about climate"], status: "completed" },
      { projectId: folding, messages: ["about folds"], status: "completed" },
    ]);
  });
});

describe("csbridge link --all, run again", () => {
  it("keeps the folders linked to their project as they are and adds folders for new projects", async () => {
    fake.addProject("Protein folding");
    await link(["--all", "."]);
    await writeFile(join(folder, "Protein folding", "notes.txt"), "my notes", "utf8");
    const before = await filesBelow(join(folder, "Protein folding"));
    const climate = fake.addProject("Climate model");

    const result = await link(["--all", "."]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `unchanged  Protein folding\ncreated    Climate model\n${nextStep(folder)}`,
      stderr: "",
    });
    expect(await filesBelow(join(folder, "Protein folding"))).toEqual(before);
    expect((await findProjectLink(join(folder, "Climate model")))?.projectId).toBe(climate);
  });
});

describe("csbridge link --all where a project's folder exists already", () => {
  it("links the folder when it is not linked, keeping what is in it", async () => {
    const projectId = fake.addProject("Protein folding");
    const existing = join(folder, "Protein folding");
    await mkdir(existing);
    await writeFile(join(existing, "notes.txt"), "my notes", "utf8");

    const result = await link(["--all", "."]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `linked     Protein folding\n${nextStep(folder)}`,
      stderr: "",
    });
    expect(await findProjectLink(existing)).toEqual({
      projectId,
      name: "Protein folding",
      folder: existing,
    });
    expect(await readFile(join(existing, "notes.txt"), "utf8")).toBe("my notes");
  });

  it("links the folder itself when it is only linked through the folder above", async () => {
    const climate = fake.addProject("Climate model");
    const folding = fake.addProject("Protein folding");
    await link(["--project", climate]);
    await mkdir(join(folder, "Protein folding"));

    const result = await link(["--all", "."]);

    expect(result.stdout).toBe(
      `created    Climate model\nlinked     Protein folding\n${nextStep(folder)}`,
    );
    expect((await findProjectLink(join(folder, "Protein folding")))?.projectId).toBe(folding);
    expect((await findProjectLink(folder))?.projectId).toBe(climate);
  });

  it("leaves a folder linked to another project alone, goes on with the others, and fails", async () => {
    const folding = fake.addProject("Protein folding");
    const climate = fake.addProject("Climate model");
    const taken = join(folder, "Protein folding");
    await mkdir(taken);
    await link(["--project", climate, "Protein folding"]);
    const before = await filesBelow(taken);

    const result = await link(["--all", "."]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: `created    Climate model\n${nextStep(folder)}`,
      stderr:
        "skipped    Protein folding: the folder is linked to another project, " +
        `"Climate model" (${climate})\n${SKIPPED}`,
    });
    expect(await filesBelow(taken)).toEqual(before);
    expect((await findProjectLink(taken))?.projectId).not.toBe(folding);
    expect((await findProjectLink(join(folder, "Climate model")))?.projectId).toBe(climate);
  });

  it("skips a project whose folder name is taken by a file", async () => {
    fake.addProject("Protein folding");
    await writeFile(join(folder, "Protein folding"), "not a folder", "utf8");

    const result = await link(["--all", "."]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `skipped    Protein folding: a file of that name is in the way\n${SKIPPED}`,
    });
    expect(await readFile(join(folder, "Protein folding"), "utf8")).toBe("not a folder");
  });

  it("skips a folder whose link cannot be read, passing on what is wrong with it", async () => {
    const projectId = fake.addProject("Protein folding");
    const broken = join(folder, "Protein folding");
    await mkdir(broken);
    await link(["--project", projectId, "Protein folding"]);
    const [marker = ""] = Object.keys(await filesBelow(broken));
    await writeFile(join(broken, marker), "{ not json", "utf8");

    const result = await link(["--all", "."]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^skipped {4}Protein folding: its link cannot be read: .*is not valid JSON/,
    );
    expect(result.stderr.endsWith(SKIPPED)).toBe(true);
    expect(await readFile(join(broken, marker), "utf8")).toBe("{ not json");
  });
});

describe("csbridge link --all with wrong usage", () => {
  const USAGE =
    "Usage: csbridge link --project <id or name> [folder]\n" +
    "       csbridge link --all <folder>\n";
  const BOTH = "Use either --all or --project, not both.";

  it.each([
    { argv: ["--all"], problem: "--all needs the folder to create the project folders in." },
    { argv: ["--all", "--project", "Protein folding", "."], problem: BOTH },
    { argv: [".", "--project=Protein folding", "--all"], problem: BOTH },
    { argv: ["--all", "one", "two"], problem: "Give at most one folder." },
    { argv: ["--all=."], problem: 'Unknown option "--all=.".' },
  ])("rejects $argv", async ({ argv, problem }) => {
    fake.addProject("Protein folding");

    const result = await link(argv);

    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: `${problem}\n\n${USAGE}` });
    expect(await readdir(folder)).toEqual([]);
  });
});

describe("csbridge link --all with nothing to do", () => {
  it("says so on standard error when there are no projects", async () => {
    const result = await link(["--all", "."]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "You have no projects yet: create one in Claude Science first.\n",
    });
    expect(await readdir(folder)).toEqual([]);
  });

  it("fails when the folder does not exist, without creating it", async () => {
    fake.addProject("Protein folding");
    const missing = join(folder, "no-such-folder");

    const result = await link(["--all", "no-such-folder"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${missing} is not an existing folder. Create it first, or check the path.\n`,
    });
    expect(await readdir(folder)).toEqual([]);
  });

  it("fails with the reason on standard error when the daemon is not running", async () => {
    const scienceCli = async () => JSON.stringify({ running: false });

    const result = await runCommand(["link", "--all", "."], { scienceCli, cwd: folder });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Claude Science is not running.*claude-science serve/);
    expect(await readdir(folder)).toEqual([]);
  });
});

/** Every file below `root` with its text, to tell whether anything was written there. */
async function filesBelow(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files[relative(root, file)] = await readFile(file, "utf8");
  }
  return files;
}
