import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectLink, writeProjectLink } from "../index.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "csbridge-link-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeProjectLink", () => {
  it("links a folder so that the link is found from that folder", async () => {
    await writeProjectLink(root, { projectId: "proj_aaaaaaaaaaaa", name: "Protein folding" });

    expect(await findProjectLink(root)).toEqual({
      projectId: "proj_aaaaaaaaaaaa",
      name: "Protein folding",
      folder: root,
    });
  });

  it("writes the documented marker file layout", async () => {
    await writeProjectLink(
      root,
      { projectId: "proj_aaaaaaaaaaaa", name: "Protein folding" },
      { now: () => new Date("2026-11-15T08:00:00Z") },
    );

    const marker = JSON.parse(
      await readFile(join(root, ".claude-science", "project.json"), "utf8"),
    );
    expect(marker).toEqual({
      schemaVersion: 1,
      projectId: "proj_aaaaaaaaaaaa",
      name: "Protein folding",
      linkedAt: "2026-11-15T08:00:00.000Z",
    });
  });

  it("replaces an existing link", async () => {
    await writeProjectLink(root, { projectId: "proj_aaaaaaaaaaaa", name: "Old" });
    await writeProjectLink(root, { projectId: "proj_bbbbbbbbbbbb", name: "New" });

    expect((await findProjectLink(root))?.name).toBe("New");
  });
});
