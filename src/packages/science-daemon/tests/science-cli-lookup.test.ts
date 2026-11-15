import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectScienceDaemon, createScienceCli, type ScienceCli } from "../index.ts";

/**
 * Four places a Science CLI can be installed, all inside one temporary folder. Each test installs
 * stand-in programs in some of them: small scripts that print where they are installed.
 */
interface Places {
  /** A path to pass as the command-line option. */
  readonly option: string;
  /** A path to put in `CLAUDE_SCIENCE_BIN`. */
  readonly environment: string;
  /** A folder to put on `PATH`. */
  readonly pathFolder: string;
  /** A stand-in for the user's home folder, which holds the default data folder. */
  readonly homeFolder: string;
}

let root: string;
let places: Places;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "csbridge-science-cli-"));
  places = {
    option: join(root, "from-option", "claude-science"),
    environment: join(root, "from-environment", "claude-science"),
    pathFolder: join(root, "on-path"),
    homeFolder: join(root, "home"),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Installs a stand-in program at `path` that prints `label` and the arguments it was given. */
async function install(path: string, label: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\necho "${label}: $*"\n`, { encoding: "utf8", mode: 0o755 });
}

const onPath = () => join(places.pathFolder, "claude-science");
const inDefaultDataFolder = () =>
  join(places.homeFolder, ".claude-science", "bin", "claude-science");

/** The Science CLI under test. It never looks outside the temporary folder. */
function scienceCliWith(options: {
  executable?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): ScienceCli {
  return createScienceCli({ env: {}, ...options, homeFolder: places.homeFolder });
}

describe("finding the Science CLI", () => {
  it("prefers the command-line option over every other place", async () => {
    await install(places.option, "option");
    await install(places.environment, "environment");
    await install(onPath(), "path");
    await install(inDefaultDataFolder(), "default data folder");

    const scienceCli = scienceCliWith({
      executable: places.option,
      env: { CLAUDE_SCIENCE_BIN: places.environment, PATH: places.pathFolder },
    });

    expect(await scienceCli(["status", "--json"])).toBe("option: status --json\n");
  });

  it("uses CLAUDE_SCIENCE_BIN ahead of PATH and the default data folder", async () => {
    await install(places.environment, "environment");
    await install(onPath(), "path");
    await install(inDefaultDataFolder(), "default data folder");

    const scienceCli = scienceCliWith({
      env: { CLAUDE_SCIENCE_BIN: places.environment, PATH: places.pathFolder },
    });

    expect(await scienceCli(["status"])).toBe("environment: status\n");
  });

  it("searches PATH ahead of the default data folder", async () => {
    await install(onPath(), "path");
    await install(inDefaultDataFolder(), "default data folder");
    const emptyFolder = join(root, "nothing-here");

    const scienceCli = scienceCliWith({
      env: { PATH: [emptyFolder, places.pathFolder].join(delimiter) },
    });

    expect(await scienceCli(["status"])).toBe("path: status\n");
  });

  it("falls back to the default data folder", async () => {
    await install(inDefaultDataFolder(), "default data folder");

    const scienceCli = scienceCliWith({ env: { PATH: places.pathFolder } });

    expect(await scienceCli(["url"])).toBe("default data folder: url\n");
  });

  it("fails naming CLAUDE_SCIENCE_BIN when the Science CLI is in none of the places", async () => {
    const scienceCli = scienceCliWith({ env: { PATH: places.pathFolder } });

    await expect(scienceCli(["status"])).rejects.toMatchObject({
      kind: "science-cli-failed",
      message: expect.stringMatching(/Could not find the Science CLI.*CLAUDE_SCIENCE_BIN/),
    });
  });

  it("does not fall back when the path in CLAUDE_SCIENCE_BIN holds no program", async () => {
    await install(onPath(), "path");

    const scienceCli = scienceCliWith({
      env: { CLAUDE_SCIENCE_BIN: places.environment, PATH: places.pathFolder },
    });

    await expect(scienceCli(["status"])).rejects.toMatchObject({
      kind: "science-cli-failed",
      message: expect.stringContaining(`${places.environment}, the path in CLAUDE_SCIENCE_BIN`),
    });
  });

  it("does not fall back when the path given as the option holds no program", async () => {
    await install(places.environment, "environment");

    const scienceCli = scienceCliWith({
      executable: places.option,
      env: { CLAUDE_SCIENCE_BIN: places.environment },
    });

    await expect(scienceCli(["status"])).rejects.toMatchObject({
      kind: "science-cli-failed",
      message: expect.stringContaining(`${places.option}, the path given on the command line`),
    });
  });

  it("skips a file on PATH that cannot be executed", async () => {
    await mkdir(places.pathFolder, { recursive: true });
    await writeFile(onPath(), "not a program", { encoding: "utf8", mode: 0o644 });
    await install(inDefaultDataFolder(), "default data folder");

    const scienceCli = scienceCliWith({ env: { PATH: places.pathFolder } });

    expect(await scienceCli(["status"])).toBe("default data folder: status\n");
  });
});

describe("running a Science CLI that was found but does not do its job", () => {
  /** Installs `script` as the program the command-line option names. */
  async function installScript(script: string): Promise<void> {
    await mkdir(dirname(places.option), { recursive: true });
    await writeFile(places.option, `#!/bin/sh\n${script}\n`, { encoding: "utf8", mode: 0o755 });
  }

  it("says that the call failed and to run it in a terminal, not that the program is missing", async () => {
    await installScript("exit 3");

    const connecting = connectScienceDaemon({
      scienceCli: scienceCliWith({ executable: places.option }),
    });

    await expect(connecting).rejects.toMatchObject({
      kind: "science-cli-failed",
      message:
        '"claude-science status" failed with exit code 3. ' +
        "Run it in a terminal to see what is wrong.",
    });
  });

  it("says that the call ran out of time and to run it in a terminal, not that the program is missing", async () => {
    await installScript("exec sleep 5");

    const connecting = connectScienceDaemon({
      scienceCli: scienceCliWith({ executable: places.option, timeoutMs: 50 }),
    });

    await expect(connecting).rejects.toMatchObject({
      kind: "science-cli-failed",
      message:
        '"claude-science status" did not finish in time and was stopped. ' +
        "Run it in a terminal to see what holds it up.",
    });
  });
});
