import { LONGEST_FOLDER_NAME, portableFolderName } from "./portable-folder-name.ts";

/** What a folder name is chosen from. */
export interface NamedProject {
  /** The daemon's identifier for the project. Tells projects of the same name apart. */
  readonly projectId: string;
  /** The name the user gave the project. Any text at all. */
  readonly name: string;
}

/** A project and the name of the folder that stands for it. */
export interface ProjectFolderName<P extends NamedProject> {
  readonly project: P;
  /** One path segment, never a path. */
  readonly folderName: string;
}

/** A longer identifier is cut, so that the name keeps most of the room whatever the daemon sends. */
const LONGEST_IDENTIFIER = 24;

/**
 * Chooses the name of the folder that stands for each project: the project's name, made valid
 * on macOS, Linux and Windows and at most 60 characters long.
 *
 * Projects that would share a folder, also on a file system that ignores letter case, each get
 * their identifier appended. All of them do, rather than all but the first, so that a project's
 * folder name does not depend on the order the projects come in.
 *
 * @returns each project with its folder name, in the order of `projects`.
 */
export function projectFolderNames<P extends NamedProject>(
  projects: readonly P[],
): ProjectFolderName<P>[] {
  const named = projects.map((project) => ({
    project,
    folderName: portableFolderName(project.name),
  }));
  const uses = new Map<string, number>();
  for (const { folderName } of named) {
    uses.set(sameFolder(folderName), (uses.get(sameFolder(folderName)) ?? 0) + 1);
  }
  return named.map(({ project, folderName }) =>
    uses.get(sameFolder(folderName)) === 1
      ? { project, folderName }
      : { project, folderName: folderNameWithIdentifier(project) },
  );
}

/** Equal for two names that macOS or Windows would take for the same folder. */
function sameFolder(folderName: string): string {
  return folderName.normalize("NFC").toLowerCase();
}

function folderNameWithIdentifier(project: NamedProject): string {
  const identifier = ` (${portableFolderName(project.projectId, LONGEST_IDENTIFIER)})`;
  const name = portableFolderName(project.name, LONGEST_FOLDER_NAME - identifier.length);
  return `${name}${identifier}`;
}
