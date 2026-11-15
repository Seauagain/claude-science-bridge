import { describe, expect, it } from "vitest";
import { createT3Cli } from "../index.ts";

describe("the T3 Code command line", () => {
  it("returns what the program writes to standard output", async () => {
    const t3 = createT3Cli(process.execPath);

    const output = await t3([
      "-e",
      "process.stdout.write(process.argv.slice(1).join('+'))",
      "a b",
      "c",
    ]);

    expect(output).toBe("a b+c");
  });

  it("fails with the first line the program wrote, which T3 Code writes to standard output", async () => {
    const t3 = createT3Cli(process.execPath);

    const failure = t3([
      "-e",
      "console.log('\\nERROR: ProjectAlreadyExistsError: there is one\\n    at somewhere'); process.exit(1)",
    ]);

    await expect(failure).rejects.toThrow(/^ERROR: ProjectAlreadyExistsError: there is one$/);
  });

  it("fails with what the program wrote to standard error when that is all there is", async () => {
    const t3 = createT3Cli(process.execPath);

    const failure = t3(["-e", "process.stderr.write('no such thread'); process.exit(1)"]);

    await expect(failure).rejects.toThrow(/^no such thread$/);
  });

  it("says that T3 Code is missing when there is no such program", async () => {
    const t3 = createT3Cli("csbridge-no-such-program");

    await expect(t3(["project", "list"])).rejects.toThrow(/T3 Code command line.*not found/);
  });
});
