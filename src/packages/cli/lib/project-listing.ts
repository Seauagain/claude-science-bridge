import { connectScienceDaemon, type Project, type ScienceCli } from "../../science-daemon/index.ts";

/** Asks the daemon for the user's projects, over a connection opened just for that. */
export async function fetchProjects(scienceCli: ScienceCli): Promise<Project[]> {
  const daemon = await connectScienceDaemon({ scienceCli });
  try {
    return await daemon.listProjects();
  } finally {
    daemon.close();
  }
}

/** What to tell a user whose project list is empty. */
export const NO_PROJECTS = "You have no projects yet: create one in Claude Science first.";

/** One project as a line of a listing: the identifier, then the name. */
export function projectLine(project: Project): string {
  return `${project.projectId}  ${project.name}`;
}
