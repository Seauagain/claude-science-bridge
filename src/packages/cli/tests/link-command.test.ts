import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("csbridge link", () => {
  it("links the current folder to the project with the given identifier", async () => {
    const projectId = fake.addProject("Protein folding");

    const result = await link(["--project", projectId]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `Linked ${folder} to "Protein folding" (${projectId}).\n`,
      stderr: "",
    });
    expect(await findProjectLink(folder)).toEqual({
      projectId,
      name: "Protein folding",
      folder,
    });
  });

  it("finds the project by name, whatever the letter case", async () => {
    const projectId = fake.addProject("Protein folding");

    const result = await link(["--project", "protein Folding"]);

    expect(result.stdout).toBe(`Linked ${folder} to "Protein folding" (${projectId}).\n`);
    expect((await findProjectLink(folder))?.projectId).toBe(projectId);
  });

  it("fails when no project matches, listing the projects there are", async () => {
    const folding = fake.addProject("Protein folding");
    const climate = fake.addProject("Climate model");

    const result = await link(["--project", "Astronomy"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        'No project has the identifier or name "Astronomy". Your projects:\n' +
        `  ${folding}  Protein folding\n` +
        `  ${climate}  Climate model\n`,
    });
    expect(await findProjectLink(folder)).toBeUndefined();
  });

  it("fails when no project matches and there are no projects at all", async () => {
    const result = await link(["--project", "Astronomy"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        'No project has the identifier or name "Astronomy". ' +
        "You have no projects yet: create one in Claude Science first.\n",
    });
  });

  it("fails when several projects have the name, listing them", async () => {
    const first = fake.addProject("Protein folding");
    const second = fake.addProject("Protein folding");
    fake.addProject("Climate model");

    const result = await link(["--project", "Protein folding"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        'Several projects are named "Protein folding". Pass the identifier of one of them:\n' +
        `  ${first}  Protein folding\n` +
        `  ${second}  Protein folding\n`,
    });
    expect(await findProjectLink(folder)).toBeUndefined();
  });

  it("does not link to an archived project", async () => {
    const archived = fake.addProject("Finished study", { archived: true });

    const result = await link(["--project", archived]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^No project has the identifier or name/);
    expect(await findProjectLink(folder)).toBeUndefined();
  });

  it("links the folder given as an argument, resolved against the working folder", async () => {
    const projectId = fake.addProject("Protein folding");
    const analysis = join(folder, "analysis");
    await mkdir(analysis);

    const result = await link(["--project", projectId, "analysis"]);

    expect(result.stdout).toBe(`Linked ${analysis} to "Protein folding" (${projectId}).\n`);
    expect((await findProjectLink(analysis))?.folder).toBe(analysis);
    expect(await findProjectLink(folder)).toBeUndefined();
  });

  it("accepts the folder before the option, and the option written with an equals sign", async () => {
    const projectId = fake.addProject("Protein folding");
    const analysis = join(folder, "analysis");
    await mkdir(analysis);

    const result = await link(["analysis", `--project=${projectId}`]);

    expect(result.stdout).toBe(`Linked ${analysis} to "Protein folding" (${projectId}).\n`);
  });

  it("fails when the folder does not exist, without creating it", async () => {
    const projectId = fake.addProject("Protein folding");
    const missing = join(folder, "no-such-folder");

    const result = await link(["--project", projectId, "no-such-folder"]);

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${missing} is not an existing folder. Create it first, or check the path.\n`,
    });
    await expect(stat(missing)).rejects.toThrow();
  });

  it("fails with the reason on standard error when the daemon is not running", async () => {
    const scienceCli = async () => JSON.stringify({ running: false });

    const result = await runCommand(["link", "--project", "Protein folding"], {
      scienceCli,
      cwd: folder,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Claude Science is not running.*claude-science serve/);
  });
});

describe("a link written by csbridge link", () => {
  it("puts sessions opened in the folder, or in a folder below it, in the project", async () => {
    fake.addProject("Climate model");
    const projectId = fake.addProject("Protein folding");
    const below = join(folder, "analysis", "figures");
    await mkdir(below, { recursive: true });
    await link(["--project", projectId]);

    const adapter = startCli(["acp"], fake);
    const client = acpClient(adapter);
    await client.initialize();
    await client.prompt(await client.openSession(folder), "from the folder");
    await client.prompt(await client.openSession(below), "from below");
    adapter.stdin.end();
    await adapter.exitCode;

    expect(fake.conversations()).toEqual([
      { projectId, messages: ["from the folder"], status: "completed" },
      { projectId, messages: ["from below"], status: "completed" },
    ]);
  });
});

describe("csbridge link in a folder that is already linked", () => {
  it("replaces the link and says which project it pointed to before", async () => {
    const before = fake.addProject("Protein folding");
    const after = fake.addProject("Climate model");
    await link(["--project", before]);

    const result = await link(["--project", after]);

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        `Linked ${folder} to "Climate model" (${after}).\n` +
        `It was linked to "Protein folding" (${before}) before.\n`,
      stderr: "",
    });
    expect((await findProjectLink(folder))?.projectId).toBe(after);
  });

  it("says so when the link it shadows belongs to a folder above", async () => {
    const outer = fake.addProject("Protein folding");
    const inner = fake.addProject("Climate model");
    const analysis = join(folder, "analysis");
    await mkdir(analysis);
    await link(["--project", outer]);

    const result = await link(["--project", inner, "analysis"]);

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        `Linked ${analysis} to "Climate model" (${inner}).\n` +
        `It was linked to "Protein folding" (${outer}) before, ` +
        `through ${folder}. That link is unchanged.\n`,
      stderr: "",
    });
    expect((await findProjectLink(analysis))?.projectId).toBe(inner);
    expect((await findProjectLink(folder))?.projectId).toBe(outer);
  });

  it("replaces a link that cannot be read, passing on what is wrong with it", async () => {
    const projectId = fake.addProject("Protein folding");
    const marker = join(folder, ".claude-science", "project.json");
    await mkdir(join(folder, ".claude-science"));
    await writeFile(marker, "{ not json", "utf8");

    const result = await link(["--project", projectId]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`Linked ${folder} to "Protein folding" (${projectId}).\n`);
    expect(result.stderr).toMatch(/^The previous link could not be read: .*is not valid JSON/);
    expect((await findProjectLink(folder))?.projectId).toBe(projectId);
  });
});

describe("csbridge link with wrong usage", () => {
  const USAGE = "Usage: csbridge link --project <id or name> [folder]\n";

  it.each([
    { argv: [], problem: "Say which project to link to with --project." },
    { argv: ["--project"], problem: "--project needs a value: a project identifier or name." },
    { argv: ["--project="], problem: "--project needs a value: a project identifier or name." },
    { argv: ["--frobnicate", "--project", "x"], problem: 'Unknown option "--frobnicate".' },
    { argv: ["--project", "x", "one", "two"], problem: "Give at most one folder." },
  ])("rejects $argv", async ({ argv, problem }) => {
    const result = await link(argv);

    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: `${problem}\n\n${USAGE}` });
    expect(await findProjectLink(folder)).toBeUndefined();
  });
});
