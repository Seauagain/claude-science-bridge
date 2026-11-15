import { findProjectLink, ProjectLinkError } from "../../project-link/index.ts";
import { checkDaemonSetup, type ScienceCli, type SetupCheck } from "../../science-daemon/index.ts";
import type { CliIo } from "./run-cli.ts";

const LABELS: Readonly<Record<SetupCheck["status"], string>> = {
  pass: "ok",
  warning: "warn",
  failure: "FAIL",
};

/**
 * `csbridge doctor`: checks the whole setup and prints one line per check on standard output.
 * Returns 1 when a check failed and 0 otherwise; a warning does not fail it.
 */
export async function runDoctorCommand(io: CliIo & { scienceCli: ScienceCli }): Promise<number> {
  const checks = [...(await checkDaemonSetup(io.scienceCli)), await checkProjectLink(io.cwd)];
  for (const check of checks) {
    io.stdout.write(`${LABELS[check.status].padEnd(4)}  ${check.name}: ${check.message}\n`);
  }
  return checks.some((check) => check.status === "failure") ? 1 : 0;
}

/** Whether `folder` is linked to a project. Not being linked is no fault of the setup: a warning. */
async function checkProjectLink(folder: string): Promise<SetupCheck> {
  const name = "Project link";
  try {
    const link = await findProjectLink(folder);
    if (link === undefined) {
      return {
        name,
        status: "warning",
        message:
          `${folder} is not linked to a project. ` +
          'Run "csbridge link --project <name>" in the folder you want to open sessions in.',
      };
    }
    return {
      name,
      status: "pass",
      message: `${link.folder} is linked to the project "${link.name}" (${link.projectId})`,
    };
  } catch (error) {
    if (!(error instanceof ProjectLinkError)) throw error;
    return { name, status: "failure", message: error.message };
  }
}
