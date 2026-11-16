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

describe("asking csbridge how it is used", () => {
  it.each(["--help", "-h", "help"])("prints the usage to standard output for %s", async (asked) => {
    const result = await runCommand([asked], fake);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Usage: csbridge <command>\n/);
    expect(result.stdout).toContain("csbridge doctor");
    expect(result.stderr).toBe("");
  });

  it("prints the usage for a command asked for help, without running the command", async () => {
    fake.addProject("Protein folding");

    const result = await runCommand(["projects", "--help"], fake);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Usage: csbridge <command>\n/);
    expect(result.stdout).not.toContain("Protein folding");
  });

  it("treats no command as wrong usage, with the usage on standard error", async () => {
    const result = await runCommand([], fake);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/^Usage: csbridge <command>\n/);
    expect(result.stdout).toBe("");
  });

  it("names a command it does not know, as wrong usage", async () => {
    const result = await runCommand(["export"], fake);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/^Unknown command "export"\.\n\nUsage: csbridge <command>\n/);
    expect(result.stdout).toBe("");
  });
});
