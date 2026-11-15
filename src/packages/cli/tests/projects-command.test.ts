import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../science-daemon/testing.ts";
import { runCommand } from "./support/cli.ts";

let fake: FakeScienceDaemon;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
});

afterEach(async () => {
  await fake.close();
});

describe("csbridge projects", () => {
  it("prints the identifier and name of each project to standard output", async () => {
    const folding = fake.addProject("Protein folding");
    const climate = fake.addProject("Climate model");

    const result = await runCommand(["projects"], fake);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${folding}  Protein folding\n${climate}  Climate model\n`,
      stderr: "",
    });
  });

  it("leaves out archived projects", async () => {
    fake.addProject("Finished study", { archived: true });
    const climate = fake.addProject("Climate model");

    const result = await runCommand(["projects"], fake);

    expect(result.stdout).toBe(`${climate}  Climate model\n`);
  });

  it("says so on standard error when there are no projects", async () => {
    const result = await runCommand(["projects"], fake);

    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "You have no projects yet: create one in Claude Science first.\n",
    });
  });

  it("rejects arguments, since it takes none", async () => {
    const result = await runCommand(["projects", "--all"], fake);

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: 'Unexpected argument "--all".\n\nUsage: csbridge projects\n',
    });
  });

  it("fails with the reason on standard error when the daemon is not running", async () => {
    const scienceCli = async () => JSON.stringify({ running: false });

    const result = await runCommand(["projects"], { scienceCli });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Claude Science is not running.*claude-science serve/);
  });
});
