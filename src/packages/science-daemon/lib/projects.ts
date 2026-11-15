import type { DaemonHttp } from "./http.ts";
import { expectArray, expectRecord, expectString, type JsonRecord } from "./validate.ts";

/** A Claude Science project, as far as this program needs to know it. */
export interface Project {
  /** The daemon's identifier for the project. */
  readonly projectId: string;
  /** The name the user gave the project. Not unique. */
  readonly name: string;
}

/**
 * Fetches the user's projects that are not archived, in the daemon's order. See `GET /projects`
 * in docs/protocol.md.
 */
export async function listProjects(http: DaemonHttp): Promise<Project[]> {
  const call = "GET /projects";
  const response = expectRecord(await http.get("/projects"), call);
  return expectArray(response, "projects", call)
    .map((entry) => expectRecord(entry, call))
    .filter((project) => !isArchived(project))
    .map((project) => ({
      projectId: expectString(project, "project_id", call),
      name: expectString(project, "name", call),
    }));
}

/**
 * The type of `archived_at` is not documented. Anything but null or a missing field counts as
 * archived, so that a project the user has put away is never offered by mistake.
 */
function isArchived(project: JsonRecord): boolean {
  return project.archived_at !== null && project.archived_at !== undefined;
}
