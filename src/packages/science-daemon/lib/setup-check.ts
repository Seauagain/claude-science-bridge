import { parseDaemonStatus } from "./endpoint.ts";
import { ScienceDaemonError } from "./errors.ts";
import { createDaemonHttp } from "./http.ts";
import { logIn } from "./login.ts";
import { runScienceCli, type ScienceCli } from "./science-cli.ts";
import { untestedVersionWarning } from "./tested-versions.ts";

/** The result of one check of the user's setup, to be shown on one line. */
export interface SetupCheck {
  /** What was checked, for example "Daemon version". */
  readonly name: string;
  /** A warning is worth the user's attention but does not keep csbridge from working. */
  readonly status: "pass" | "warning" | "failure";
  /** One line: what was found and, unless the check passed, what to do next. */
  readonly message: string;
}

/** The checks of {@link checkDaemonSetup}, in the order they are made and reported. */
const CHECK_NAMES = ["Science CLI", "Daemon", "Daemon version", "Login"] as const;

/**
 * Checks everything csbridge needs from Claude Science, one step at a time: the Science CLI can
 * be found, the daemon is running, its version is one this release was tested with, and a login
 * works. Always returns those four checks, in that order. A check that could not be made because
 * an earlier one failed is reported as a failure that points at the earlier one.
 */
export async function checkDaemonSetup(scienceCli: ScienceCli): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];
  try {
    const status = await runScienceCli(scienceCli, ["status"]);
    checks.push({ name: "Science CLI", status: "pass", message: "found" });

    const endpoint = parseDaemonStatus(status);
    checks.push({ name: "Daemon", status: "pass", message: `running at ${endpoint.baseUrl}` });

    const warning = untestedVersionWarning(endpoint.version);
    checks.push(
      warning === undefined
        ? { name: "Daemon version", status: "pass", message: `${endpoint.version}, tested` }
        : { name: "Daemon version", status: "warning", message: warning },
    );

    const login = await logIn(endpoint, scienceCli);
    await createDaemonHttp(endpoint, login).get("/me");
    checks.push({ name: "Login", status: "pass", message: "the daemon accepted a login link" });
  } catch (error) {
    if (!(error instanceof ScienceDaemonError)) throw error;
    const [failed = "Login", ...notChecked] = CHECK_NAMES.slice(checks.length);
    checks.push({ name: failed, status: "failure", message: error.message });
    for (const name of notChecked) {
      checks.push({
        name,
        status: "failure",
        message: `not checked, because the "${failed}" check failed. Fix that first.`,
      });
    }
  }
  return checks;
}
