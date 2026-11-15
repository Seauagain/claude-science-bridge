import { join } from "node:path";

/** The project a folder is linked to. */
export interface ProjectLink {
  /** The daemon's identifier for the project. */
  readonly projectId: string;
  /** The project's name when the link was written. Informational: the daemon is authoritative. */
  readonly name: string;
  /** Absolute path of the folder that holds the marker file. */
  readonly folder: string;
}

/** A marker file exists but cannot be used. The message names the file and the reason. */
export class ProjectLinkError extends Error {
  override readonly name = "ProjectLinkError";
}

/** The only marker file layout this version reads and writes. */
export const SCHEMA_VERSION = 1;

/**
 * Path of the marker file inside `folder`.
 *
 * The marker has a folder name of its own, not Claude Science's: `~/.claude-science` is the
 * daemon's data folder, which csbridge must never write into, and the home folder can be linked
 * like any other.
 */
export function markerPath(folder: string): string {
  return join(folder, ".csbridge", "project.json");
}
