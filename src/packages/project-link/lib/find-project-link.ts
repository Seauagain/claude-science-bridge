import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { markerPath, type ProjectLink, ProjectLinkError, SCHEMA_VERSION } from "./project-link.ts";

/**
 * Finds the project that `startFolder` is linked to, looking in the folder itself and then in
 * each ancestor. The nearest marker file wins.
 *
 * @returns the link, or `undefined` when neither the folder nor any ancestor is linked.
 * @throws ProjectLinkError when the nearest marker file is unreadable, malformed, or written by
 *   an unknown schema version. A broken link is reported rather than skipped, so that a
 *   conversation never lands silently in an outer folder's project.
 */
export async function findProjectLink(startFolder: string): Promise<ProjectLink | undefined> {
  let folder = resolve(startFolder);
  for (;;) {
    const contents = await readMarker(folder);
    if (contents !== undefined) return parseMarker(contents, folder);

    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

async function readMarker(folder: string): Promise<string | undefined> {
  try {
    return await readFile(markerPath(folder), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new ProjectLinkError(`Cannot read ${markerPath(folder)}: ${describe(error)}`);
  }
}

function parseMarker(contents: string, folder: string): ProjectLink {
  const file = markerPath(folder);
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ProjectLinkError(`${file} is not valid JSON. Fix it or run "csbridge link" again.`);
  }

  if (!isRecord(value)) {
    throw new ProjectLinkError(`${file} must hold a JSON object. Run "csbridge link" again.`);
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new ProjectLinkError(
      `${file} has schemaVersion ${JSON.stringify(value.schemaVersion)}, but this version of ` +
        `csbridge only understands ${SCHEMA_VERSION}. Upgrade csbridge or run "csbridge link" again.`,
    );
  }
  if (typeof value.projectId !== "string" || value.projectId === "") {
    throw new ProjectLinkError(`${file} has no projectId. Run "csbridge link" again.`);
  }

  return {
    projectId: value.projectId,
    name: typeof value.name === "string" ? value.name : "",
    folder,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for the errors that mean "there is no marker file here", as opposed to a real failure. */
function isMissingFile(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
