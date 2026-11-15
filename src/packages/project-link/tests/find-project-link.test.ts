import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectLink, ProjectLinkError } from "../index.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "csbridge-link-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeMarker(folder: string, contents: string): Promise<void> {
  await mkdir(join(folder, ".csbridge"), { recursive: true });
  await writeFile(join(folder, ".csbridge", "project.json"), contents, "utf8");
}

const marker = (projectId: string, name: string) =>
  JSON.stringify({ schemaVersion: 1, projectId, name, linkedAt: "2026-11-15T08:00:00Z" });

describe("findProjectLink", () => {
  it("returns the project a folder is linked to", async () => {
    await writeMarker(root, marker("proj_aaaaaaaaaaaa", "Protein folding"));

    expect(await findProjectLink(root)).toEqual({
      projectId: "proj_aaaaaaaaaaaa",
      name: "Protein folding",
      folder: root,
    });
  });

  it("finds the link of an ancestor folder", async () => {
    await writeMarker(root, marker("proj_aaaaaaaaaaaa", "Protein folding"));
    const nested = join(root, "notes", "week-3");
    await mkdir(nested, { recursive: true });

    expect((await findProjectLink(nested))?.projectId).toBe("proj_aaaaaaaaaaaa");
  });

  it("prefers the nearest link when several ancestors are linked", async () => {
    await writeMarker(root, marker("proj_aaaaaaaaaaaa", "Outer"));
    const inner = join(root, "inner");
    await writeMarker(inner, marker("proj_bbbbbbbbbbbb", "Inner"));

    expect((await findProjectLink(join(inner)))?.name).toBe("Inner");
  });

  it("returns undefined for a folder that is not linked", async () => {
    expect(await findProjectLink(root)).toBeUndefined();
  });

  it("rejects a link written by a newer, unknown schema version", async () => {
    await writeMarker(root, JSON.stringify({ schemaVersion: 2, projectId: "proj_x", name: "X" }));

    await expect(findProjectLink(root)).rejects.toThrow(ProjectLinkError);
  });

  it("rejects a link file that is not valid JSON, naming the file", async () => {
    await writeMarker(root, "{ not json");

    await expect(findProjectLink(root)).rejects.toThrow(/project\.json/);
  });
});
