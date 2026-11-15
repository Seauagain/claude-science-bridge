import type { ScienceCli } from "../../science-daemon/index.ts";
import { daemonSetup } from "./daemon-setup.ts";
import { reportFailure, UsageError } from "./failure.ts";
import { fetchProjects, NO_PROJECTS, projectLine } from "./project-listing.ts";
import type { CliIo } from "./run-cli.ts";

/** `csbridge projects`: prints one line per project, identifier first, then the name. */
export async function runProjectsCommand(
  args: readonly string[],
  io: CliIo & { scienceCli: ScienceCli },
): Promise<number> {
  try {
    const [unexpected] = args;
    if (unexpected !== undefined) {
      throw new UsageError(`Unexpected argument "${unexpected}".\n\nUsage: csbridge projects`);
    }
    const projects = await fetchProjects(daemonSetup(io));
    for (const project of projects) io.stdout.write(`${projectLine(project)}\n`);
    if (projects.length === 0) io.stderr.write(`${NO_PROJECTS}\n`);
    return 0;
  } catch (error) {
    return reportFailure(error, io.stderr);
  }
}
