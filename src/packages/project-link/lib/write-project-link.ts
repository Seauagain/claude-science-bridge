import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { markerPath, type ProjectLink, SCHEMA_VERSION } from "./project-link.ts";

/** Options for {@link writeProjectLink}. */
export interface WriteProjectLinkOptions {
  /** Clock used for the `linkedAt` stamp. Defaults to the system clock. */
  readonly now?: () => Date;
}

/**
 * Links `folder` to a project by writing its marker file, replacing any link the folder already
 * has. Links held by ancestor folders are left alone: the nearest one wins when looking up.
 */
export async function writeProjectLink(
  folder: string,
  project: Pick<ProjectLink, "projectId" | "name">,
  options: WriteProjectLinkOptions = {},
): Promise<void> {
  const file = markerPath(resolve(folder));
  const marker = {
    schemaVersion: SCHEMA_VERSION,
    projectId: project.projectId,
    name: project.name,
    linkedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}
