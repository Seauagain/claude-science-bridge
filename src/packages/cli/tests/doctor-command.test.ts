import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectLink } from "../../project-link/index.ts";
import { type ScienceCli, ScienceDaemonError } from "../../science-daemon/index.ts";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../../science-daemon/testing.ts";
import { runDoctor as runDoctorIn } from "./support/run-doctor.ts";

let fake: FakeScienceDaemon;
/** A temporary folder linked to the project "Protein folding" on the fake daemon. */
let linkedFolder: string;
let unlinkedFolder: string;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
  linkedFolder = await mkdtemp(join(tmpdir(), "csbridge-doctor-"));
  unlinkedFolder = await mkdtemp(join(tmpdir(), "csbridge-doctor-"));
  await writeProjectLink(linkedFolder, {
    projectId: fake.addProject("Protein folding"),
    name: "Protein folding",
  });
});

afterEach(async () => {
  await fake.close();
  await rm(linkedFolder, { recursive: true, force: true });
  await rm(unlinkedFolder, { recursive: true, force: true });
});

/** Runs `csbridge doctor` against the fake daemon, in the linked folder unless told otherwise. */
function runDoctor(setup: { cwd?: string; scienceCli?: ScienceCli } = {}) {
  return runDoctorIn({
    cwd: setup.cwd ?? linkedFolder,
    scienceCli: setup.scienceCli ?? fake.scienceCli,
  });
}

describe("csbridge doctor", () => {
  it("passes every check, one line each and in order, when the setup is right", async () => {
    const { exitCode, lines, stderr } = await runDoctor();

    expect(lines).toEqual([
      expect.stringMatching(/^ok +Science CLI: /),
      expect.stringMatching(/^ok +Daemon: /),
      expect.stringMatching(/^ok +Daemon version: 0\.1\.53/),
      expect.stringMatching(/^ok +Login: /),
      expect.stringMatching(/^ok +Project link: .*Protein folding/),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });

  it("fails naming CLAUDE_SCIENCE_BIN when the Science CLI is missing", async () => {
    const missingScienceCli = () => Promise.reject(new Error("spawn claude-science ENOENT"));

    const { exitCode, lines } = await runDoctor({ scienceCli: missingScienceCli });

    expect(lines).toEqual([
      expect.stringMatching(/^FAIL +Science CLI: .*CLAUDE_SCIENCE_BIN/),
      expect.stringMatching(/^FAIL +Daemon: not checked.*"Science CLI"/),
      expect.stringMatching(/^FAIL +Daemon version: not checked.*"Science CLI"/),
      expect.stringMatching(/^FAIL +Login: not checked.*"Science CLI"/),
      expect.stringMatching(/^ok +Project link: /),
    ]);
    expect(exitCode).toBe(1);
  });

  it("keeps a check on one line when the failure it reports spans several", async () => {
    const failsOverTwoLines = () =>
      Promise.reject(
        new ScienceDaemonError("science-cli-failed", "claude-science crashed.\n  Reinstall it."),
      );

    const { lines } = await runDoctor({ scienceCli: failsOverTwoLines });

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("FAIL  Science CLI: claude-science crashed. Reinstall it.");
  });

  it("fails naming the call when the Science CLI prints something unexpected", async () => {
    const printsNoJson = () => Promise.resolve("Claude Science is starting up\n");

    const { exitCode, lines } = await runDoctor({ scienceCli: printsNoJson });

    expect(lines.slice(0, 2)).toEqual([
      expect.stringMatching(/^ok +Science CLI: /),
      expect.stringMatching(/^FAIL +Daemon: "claude-science status" did not print JSON\. Run it/),
    ]);
    expect(exitCode).toBe(1);
  });

  it("fails saying how to start the daemon when it is not running", async () => {
    fake.reportRunning(false);

    const { exitCode, lines } = await runDoctor();

    expect(lines).toEqual([
      expect.stringMatching(/^ok +Science CLI: /),
      expect.stringMatching(/^FAIL +Daemon: .*not running.*claude-science serve/),
      expect.stringMatching(/^FAIL +Daemon version: not checked.*"Daemon"/),
      expect.stringMatching(/^FAIL +Login: not checked.*"Daemon"/),
      expect.stringMatching(/^ok +Project link: /),
    ]);
    expect(exitCode).toBe(1);
  });

  it("warns about a daemon version it was not tested with, without failing", async () => {
    fake.reportVersion("9.9.9");

    const { exitCode, lines } = await runDoctor();

    expect(lines).toEqual([
      expect.stringMatching(/^ok +Science CLI: /),
      expect.stringMatching(/^ok +Daemon: /),
      expect.stringMatching(/^warn +Daemon version: .*9\.9\.9.*not been tested.*0\.1\.53/),
      expect.stringMatching(/^ok +Login: /),
      expect.stringMatching(/^ok +Project link: /),
    ]);
    expect(exitCode).toBe(0);
  });

  it("fails with a next step, and without printing the nonce, when the login is refused", async () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const unknownLoginLink: ScienceCli = async (args) =>
      args[0] === "url" ? `http://localhost:1/?nonce=${nonce}\n` : fake.scienceCli(args);

    const { exitCode, lines, stderr } = await runDoctor({ scienceCli: unknownLoginLink });

    expect(lines).toEqual([
      expect.stringMatching(/^ok +Science CLI: /),
      expect.stringMatching(/^ok +Daemon: /),
      expect.stringMatching(/^ok +Daemon version: /),
      expect.stringMatching(/^FAIL +Login: .*did not accept the login link.*claude-science url/),
      expect.stringMatching(/^ok +Project link: /),
    ]);
    expect(exitCode).toBe(1);
    expect(lines.join("\n") + stderr).not.toContain(nonce);
  });

  it("warns, without failing, when the current folder is not linked to a project", async () => {
    const { exitCode, lines } = await runDoctor({ cwd: unlinkedFolder });

    expect(lines.slice(0, 4)).toEqual([
      expect.stringMatching(/^ok +Science CLI: /),
      expect.stringMatching(/^ok +Daemon: /),
      expect.stringMatching(/^ok +Daemon version: /),
      expect.stringMatching(/^ok +Login: /),
    ]);
    expect(lines[4]).toMatch(/^warn +Project link: .*not linked to a project.*csbridge link/);
    expect(lines[4]).toContain(unlinkedFolder);
    expect(lines).toHaveLength(5);
    expect(exitCode).toBe(0);
  });

  it("fails naming the marker file when the project link cannot be used", async () => {
    const markerFile = join(unlinkedFolder, ".claude-science", "project.json");
    await mkdir(dirname(markerFile));
    await writeFile(markerFile, "{ not json", "utf8");

    const { exitCode, lines } = await runDoctor({ cwd: unlinkedFolder });

    expect(lines[4]).toMatch(
      /^FAIL +Project link: .*project\.json is not valid JSON.*csbridge link/,
    );
    expect(lines).toHaveLength(5);
    expect(exitCode).toBe(1);
  });
});
