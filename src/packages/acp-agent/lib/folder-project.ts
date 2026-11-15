import { basename, resolve } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { findProjectLink, writeProjectLink } from "../../project-link/index.ts";
import type { Project, ScienceDaemon } from "../../science-daemon/index.ts";
import { INTERNAL_ERROR, INVALID_REQUEST } from "./errors.ts";

/** The project a folder's conversations go to. */
export interface FolderProject {
  readonly projectId: string;
  /** What to tell the client about the folder, when it had to be linked to find the project. */
  readonly note?: string;
}

/** Finds the project of a session's working folder. See {@link createFolderProjects}. */
export type FolderProjects = (folder: string) => Promise<FolderProject>;

/**
 * Builds the lookup of the project a working folder belongs to.
 *
 * A folder that is linked, itself or through a folder above it, belongs to the project of that
 * link. Any other folder is linked on the spot, so that a client can use whatever folder the
 * user opens: to the one project that has the folder's name, or to a new project of that name
 * when there is none. Archived projects do not count, and names are compared without regard to
 * case, as `csbridge link --project <name>` compares them.
 *
 * The lookup fails, having created and written nothing, when several projects have the
 * folder's name or the folder has none.
 */
export function createFolderProjects(daemon: () => Promise<ScienceDaemon>): FolderProjects {
  /**
   * The folders being linked right now. Sessions of this process that ask about the same folder
   * meanwhile share the outcome, so that the project is created once. Another adapter process
   * can still do the same at the same moment and create a second project of that name: that
   * race is accepted, and the user then sees two projects and removes one.
   */
  const linking = new Map<string, Promise<FolderProject>>();

  return async (folder) => {
    const link = await findProjectLink(folder);
    if (link !== undefined) return { projectId: link.projectId };

    const key = resolve(folder);
    let outcome = linking.get(key);
    if (outcome === undefined) {
      outcome = daemon()
        .then((science) => linkFolder(key, science))
        .finally(() => linking.delete(key));
      linking.set(key, outcome);
    }
    return outcome;
  };
}

/** Links `folder` to the project that has its name, creating that project if there is none. */
async function linkFolder(folder: string, science: ScienceDaemon): Promise<FolderProject> {
  const howToLink =
    'Run "csbridge link --project <id>" in that folder with the identifier of the project ' +
    'you mean ("csbridge projects" lists them), then send the prompt again.';
  const name = basename(folder);
  if (name === "") {
    throw new RequestError(
      INVALID_REQUEST,
      `${folder} is not linked to a Claude Science project, and it has no name that a ` +
        `project could be found or created by. ${howToLink}`,
    );
  }

  const namesakes = (await science.listProjects()).filter(
    (project) => project.name.toLowerCase() === name.toLowerCase(),
  );
  if (namesakes.length > 1) {
    const identifiers = namesakes.map((project) => project.projectId).join(", ");
    throw new RequestError(
      INVALID_REQUEST,
      `Several Claude Science projects are named "${name}" (${identifiers}), so csbridge ` +
        `cannot tell which of them ${folder} belongs to. ${howToLink}`,
    );
  }

  const [existing] = namesakes;
  const project = existing ?? (await science.createProject(name));
  await writeLink(folder, project);
  return {
    projectId: project.projectId,
    note:
      existing === undefined
        ? `Created the Claude Science project "${project.name}" and linked this folder to it.`
        : `Linked this folder to the Claude Science project "${project.name}".`,
  };
}

async function writeLink(folder: string, project: Project): Promise<void> {
  try {
    await writeProjectLink(folder, project);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(
      INTERNAL_ERROR,
      `Could not link ${folder} to the Claude Science project "${project.name}" ` +
        `(${project.projectId}): ${reason}. Nothing was sent. Check that the folder exists ` +
        "and can be written to, then send the prompt again.",
    );
  }
}
