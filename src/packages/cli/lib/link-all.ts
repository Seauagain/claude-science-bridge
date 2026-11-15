import type { Stats } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { type ProjectFolderName, projectFolderNames } from "../../folder-names/index.ts";
import { findProjectLink, ProjectLinkError, writeProjectLink } from "../../project-link/index.ts";
import type { Project } from "../../science-daemon/index.ts";
import { NO_PROJECTS } from "./project-listing.ts";

/** What was done about one project's folder. `reason` says why it was skipped. */
export interface Outcome {
  readonly done: "created" | "linked" | "unchanged" | "skipped";
  readonly reason?: string;
}

/**
 * `csbridge link --all <folder>`: gives every project a sub-folder of `parent` that is linked to
 * it, and prints one line per project saying what was done. A folder that cannot be used for its
 * project is skipped, never changed: the others are still dealt with, and the command fails.
 *
 * @returns the exit code.
 */
export async function linkEveryProject(
  projects: readonly Project[],
  parent: string,
  io: { readonly stdout: Writable; readonly stderr: Writable },
): Promise<number> {
  if (projects.length === 0) {
    io.stderr.write(`${NO_PROJECTS}\n`);
    return 0;
  }

  let skipped = 0;
  for (const named of projectFolderNames(projects)) {
    const { done, reason } = await linkSubfolder(join(parent, named.folderName), named.project);
    if (reason === undefined) {
      io.stdout.write(`${line(done, named)}\n`);
    } else {
      skipped++;
      io.stderr.write(`${line(done, named)}: ${reason}\n`);
    }
  }

  if (skipped < projects.length) {
    io.stdout.write(
      `\nNext: add the folders above, which are in ${parent}, as projects in your ACP client.\n`,
    );
  }
  if (skipped === 0) return 0;
  io.stderr.write(
    "\nA skipped folder is left as it is. Move or rename it, then run this command again.\n",
  );
  return 1;
}

/** Makes `folder` a folder linked to `project`, unless something else is in its place. */
export async function linkSubfolder(folder: string, project: Project): Promise<Outcome> {
  const entry = await entryAt(folder);
  if (entry === undefined) {
    await mkdir(folder);
    await writeProjectLink(folder, project);
    return { done: "created" };
  }
  if (!entry.isDirectory()) return skipped("a file of that name is in the way");

  const link = await findProjectLink(folder).catch((error: unknown) => {
    if (!(error instanceof ProjectLinkError)) throw error;
    return error;
  });
  // Unlike `csbridge link --project`, nobody asked for this folder in particular to be linked
  // again, and a link that cannot be read may well point to another project.
  if (link instanceof ProjectLinkError) return skipped(`its link cannot be read: ${link.message}`);

  // A link held by a folder above does not count: the sub-folder needs one of its own.
  if (link?.folder !== folder) {
    await writeProjectLink(folder, project);
    return { done: "linked" };
  }
  if (link.projectId === project.projectId) return { done: "unchanged" };
  return skipped(`the folder is linked to another project, "${link.name}" (${link.projectId})`);
}

function skipped(reason: string): Outcome {
  return { done: "skipped", reason };
}

/** What is at `path`, or `undefined` when nothing is. */
async function entryAt(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** One project as a line of the report. The project is named when its folder's name differs. */
function line(done: string, { project, folderName }: ProjectFolderName<Project>): string {
  const whose = folderName === project.name ? "" : `  (project "${project.name}")`;
  return `${done.padEnd(9)}  ${folderName}${whose}`;
}
