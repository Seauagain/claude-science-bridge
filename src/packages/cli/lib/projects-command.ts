import { connectScienceDaemon, type Project, type ScienceCli } from "../../science-daemon/index.ts";
import { reportFailure } from "./failure.ts";
import type { CliIo } from "./run-cli.ts";

/** `csbridge projects`: prints one line per project, identifier first, then the name. */
export async function runProjectsCommand(io: CliIo & { scienceCli: ScienceCli }): Promise<number> {
  try {
    for (const project of await fetchProjects(io.scienceCli)) {
      io.stdout.write(`${describeProject(project)}\n`);
    }
    return 0;
  } catch (error) {
    return reportFailure(error, io.stderr);
  }
}

/** Asks the daemon for the user's projects, over a connection opened just for that. */
export async function fetchProjects(scienceCli: ScienceCli): Promise<Project[]> {
  const daemon = await connectScienceDaemon({ scienceCli });
  try {
    return await daemon.listProjects();
  } finally {
    daemon.close();
  }
}

/** One project as a line of a listing: the identifier, then the name. */
export function describeProject(project: Project): string {
  return `${project.projectId}  ${project.name}`;
}
