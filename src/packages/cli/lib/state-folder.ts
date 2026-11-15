import { join, resolve } from "node:path";
import type { CliIo } from "./run-cli.ts";

/**
 * The folder csbridge keeps its own state in: the one `CSBRIDGE_STATE_DIR` names, or `.csbridge`
 * in the home folder. It is never the Claude Science data folder, which is `.claude-science`
 * there.
 */
export function stateFolder(io: CliIo): string {
  const named = io.env.CSBRIDGE_STATE_DIR;
  return named ? resolve(io.cwd, named) : join(io.homeFolder, ".csbridge");
}
