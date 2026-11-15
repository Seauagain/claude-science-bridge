import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  findProjectLink,
  type ProjectLink,
  ProjectLinkError,
  writeProjectLink,
} from "../../project-link/index.ts";
import type { Project } from "../../science-daemon/index.ts";
import { daemonSetup } from "./daemon-setup.ts";
import { CommandError, reportFailure } from "./failure.ts";
import { parseLinkArguments } from "./link-arguments.ts";
import { fetchProjects, NO_PROJECTS, projectLine } from "./project-listing.ts";
import type { CommandIo } from "./run-cli.ts";

/** `csbridge link --project <id or name> [folder]`: links a folder to a project. */
export async function runLinkCommand(args: readonly string[], io: CommandIo): Promise<number> {
  try {
    const wanted = parseLinkArguments(args);
    const folder = resolve(io.cwd, wanted.folder ?? ".");
    await expectFolder(folder);
    const project = chooseProject(await fetchProjects(daemonSetup(io)), wanted.project);
    const previous = await findProjectLink(folder).catch((error: unknown) => {
      // A link that cannot be read is what linking again repairs, so it must not stop the command.
      if (!(error instanceof ProjectLinkError)) throw error;
      io.stderr.write(`The previous link could not be read: ${error.message}\n`);
      return undefined;
    });
    await writeProjectLink(folder, project);
    io.stdout.write(`Linked ${folder} to "${project.name}" (${project.projectId}).\n`);
    if (previous !== undefined) io.stdout.write(`${describePrevious(previous, folder)}\n`);
    return 0;
  } catch (error) {
    return reportFailure(error, io.stderr);
  }
}

/** Says what `folder` was linked to, and whether that link was its own or a folder's above. */
function describePrevious(previous: ProjectLink, folder: string): string {
  const before = `It was linked to "${previous.name}" (${previous.projectId}) before`;
  return previous.folder === folder
    ? `${before}.`
    : `${before}, through ${previous.folder}. That link is unchanged.`;
}

/** Writing a link would create a missing folder, which hides a mistyped path. Refuse instead. */
async function expectFolder(folder: string): Promise<void> {
  const problem = `${folder} is not an existing folder. Create it first, or check the path.`;
  const entry = await stat(folder).catch((cause: unknown) => {
    throw new CommandError(problem, { cause });
  });
  if (!entry.isDirectory()) throw new CommandError(problem);
}

/**
 * Picks the project the user means. An identifier wins over a name, because names are not
 * unique and the identifier is how the user tells projects of the same name apart.
 */
function chooseProject(projects: readonly Project[], wanted: string): Project {
  const byIdentifier = projects.find((project) => project.projectId === wanted);
  if (byIdentifier !== undefined) return byIdentifier;

  const byName = projects.filter((project) => project.name.toLowerCase() === wanted.toLowerCase());
  const [only, ...others] = byName;
  if (only !== undefined && others.length === 0) return only;

  if (only !== undefined) {
    throw new CommandError(
      `Several projects are named "${wanted}". Pass the identifier of one of them:\n` +
        listing(byName),
    );
  }
  throw new CommandError(
    `No project has the identifier or name "${wanted}". ` +
      (projects.length === 0 ? NO_PROJECTS : `Your projects:\n${listing(projects)}`),
  );
}

function listing(projects: readonly Project[]): string {
  return projects.map((project) => `  ${projectLine(project)}`).join("\n");
}
