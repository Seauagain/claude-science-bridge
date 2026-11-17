import { join, resolve } from "node:path";
import type { CliIo } from "./run-cli.ts";

/**
 * The folders T3 Code saves the attachments of a prompt in: `userdata/attachments` and
 * `dev/attachments` in its home folder, which is the one `T3CODE_HOME` names or `.t3` in the
 * user's home folder. A file that a prompt names in its text is read from these folders only.
 */
export function attachmentFolders(io: CliIo): string[] {
  const named = io.env.T3CODE_HOME;
  const home = named ? resolve(io.cwd, named) : join(io.homeFolder, ".t3");
  return [join(home, "userdata", "attachments"), join(home, "dev", "attachments")];
}
