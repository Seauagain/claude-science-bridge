import { UsageError } from "./failure.ts";

/** What the user asked `csbridge link` to do. */
export interface LinkArguments {
  /** Identifier or name of the project to link to. */
  readonly project: string;
  /** The folder to link, as typed. Absent when the working folder is meant. */
  readonly folder: string | undefined;
}

const USAGE = "Usage: csbridge link --project <id or name> [folder]";
const OPTION = "--project";

/**
 * Reads the arguments that follow `csbridge link`. The option and the folder may come in either
 * order, and the option's value may follow it or be joined to it with an equals sign.
 *
 * @throws UsageError naming the first thing that is wrong.
 */
export function parseLinkArguments(args: readonly string[]): LinkArguments {
  let project: string | undefined;
  const folders: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    if (argument === OPTION) {
      index++;
      project = args[index] ?? "";
    } else if (argument.startsWith(`${OPTION}=`)) {
      project = argument.slice(OPTION.length + 1);
    } else if (argument.startsWith("-")) {
      throw wrongUsage(`Unknown option "${argument}".`);
    } else {
      folders.push(argument);
    }
  }

  if (project === undefined) throw wrongUsage(`Say which project to link to with ${OPTION}.`);
  if (project === "") {
    throw wrongUsage(`${OPTION} needs a value: a project identifier or name.`);
  }
  if (folders.length > 1) throw wrongUsage("Give at most one folder.");
  return { project, folder: folders[0] };
}

function wrongUsage(problem: string): UsageError {
  return new UsageError(`${problem}\n\n${USAGE}`);
}
