import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "./support/run-doctor.ts";

/**
 * These tests let csbridge find the Science CLI itself, so every run names a stand-in program
 * through the option or through CLAUDE_SCIENCE_BIN. That keeps the lookup away from PATH and
 * from the default data folder, where the real program may be installed.
 */
let folder: string;
/** A stand-in program that reports that no daemon is running. */
let reportsNotRunning: string;
/** A stand-in program that fails whatever it is asked. */
let alwaysFails: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "csbridge-option-"));
  reportsNotRunning = join(folder, "reports-not-running");
  alwaysFails = join(folder, "always-fails");
  await writeFile(reportsNotRunning, "#!/bin/sh\necho '{\"running\": false}'\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  await writeFile(alwaysFails, "#!/bin/sh\nexit 3\n", { encoding: "utf8", mode: 0o755 });
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const ranTheStandInThatReportsNotRunning = [
  expect.stringMatching(/^ok +Science CLI: /),
  expect.stringMatching(/^FAIL +Daemon: .*not running/),
];

describe("choosing the Science CLI on the command line", () => {
  it("uses the program CLAUDE_SCIENCE_BIN points to", async () => {
    const { lines } = await runDoctor({
      cwd: folder,
      env: { CLAUDE_SCIENCE_BIN: reportsNotRunning },
    });

    expect(lines.slice(0, 2)).toEqual(ranTheStandInThatReportsNotRunning);
  });

  it("prefers --claude-science-bin over CLAUDE_SCIENCE_BIN", async () => {
    const { lines } = await runDoctor({
      cwd: folder,
      args: ["--claude-science-bin", reportsNotRunning],
      env: { CLAUDE_SCIENCE_BIN: alwaysFails },
    });

    expect(lines.slice(0, 2)).toEqual(ranTheStandInThatReportsNotRunning);
  });

  it("accepts the option joined to its path by =", async () => {
    const { lines } = await runDoctor({
      cwd: folder,
      args: [`--claude-science-bin=${reportsNotRunning}`],
      env: { CLAUDE_SCIENCE_BIN: alwaysFails },
    });

    expect(lines.slice(0, 2)).toEqual(ranTheStandInThatReportsNotRunning);
  });

  it("resolves a relative path against the folder the command was started in", async () => {
    const { lines } = await runDoctor({
      cwd: folder,
      args: ["--claude-science-bin", "reports-not-running"],
      env: { CLAUDE_SCIENCE_BIN: alwaysFails },
    });

    expect(lines.slice(0, 2)).toEqual(ranTheStandInThatReportsNotRunning);
  });

  it("fails naming the path when the option points to no program", async () => {
    const nowhere = join(folder, "nowhere", "claude-science");

    const { exitCode, lines } = await runDoctor({
      cwd: folder,
      args: ["--claude-science-bin", nowhere],
      env: { CLAUDE_SCIENCE_BIN: reportsNotRunning },
    });

    expect(lines[0]).toMatch(/^FAIL +Science CLI: No Science CLI can be run at /);
    expect(lines[0]).toContain(nowhere);
    expect(exitCode).toBe(1);
  });

  it("refuses the option without a path as wrong usage", async () => {
    const { exitCode, lines, stderr } = await runDoctor({
      cwd: folder,
      args: ["--claude-science-bin"],
      env: { CLAUDE_SCIENCE_BIN: reportsNotRunning },
    });

    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--claude-science-bin needs the path/);
    expect(lines).toEqual([""]);
  });
});
