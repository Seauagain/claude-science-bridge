import { UsageError } from "./failure.ts";

/** What the user asked `csbridge link` to do. */
export type LinkArguments =
  | {
      readonly all: false;
      /** Identifier or name of the project to link to. */
      readonly project: string;
      /** The folder to link, as typed. Absent when the working folder is meant. */
      readonly folder: string | undefined;
    }
  | {
      /** Every project gets a linked folder of its own. */
      readonly all: true;
      /** The folder to create those folders in, as typed. */
      readonly folder: string;
    };

const USAGE = `Usage: csbridge link --project <id or name> [folder]
       csbridge link --all <folder>`;
const OPTION = "--project";
const ALL = "--all";

/**
 * Reads the arguments that follow `csbridge link`. The options and the folder may come in any
 * order, and the value of `--project` may follow it or be joined to it with an equals sign.
 *
 * @throws UsageError naming the first thing that is wrong.
 */
export function parseLinkArguments(args: readonly string[]): LinkArguments {
  let project: string | undefined;
  let all = false;
  const folders: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    if (argument === OPTION) {
      index++;
      project = args[index] ?? "";
    } else if (argument.startsWith(`${OPTION}=`)) {
      project = argument.slice(OPTION.length + 1);
    } else if (argument === ALL) {
      all = true;
    } else if (argument.startsWith("-")) {
      throw wrongUsage(`Unknown option "${argument}".`);
    } else {
      folders.push(argument);
    }
  }

  const [folder, ...others] = folders;
  if (others.length > 0) throw wrongUsage("Give at most one folder.");
  if (all) {
    if (project !== undefined) throw wrongUsage(`Use either ${ALL} or ${OPTION}, not both.`);
    if (folder === undefined) {
      throw wrongUsage(`${ALL} needs the folder to create the project folders in.`);
    }
    return { all, folder };
  }
  if (project === undefined) throw wrongUsage(`Say which project to link to with ${OPTION}.`);
  if (project === "") {
    throw wrongUsage(`${OPTION} needs a value: a project identifier or name.`);
  }
  return { all, project, folder };
}

function wrongUsage(problem: string): UsageError {
  return new UsageError(`${problem}\n\n${USAGE}`);
}
