import { DaemonAccess } from "./access.ts";
import type { ConnectOptions } from "./connect.ts";
import { parseDaemonStatus } from "./endpoint.ts";
import { ScienceDaemonError } from "./errors.ts";
import { createDaemonHttp } from "./http.ts";
import { logIn } from "./login.ts";
import { runScienceCli, type ScienceCli } from "./science-cli.ts";
import { untestedVersionWarning } from "./tested-versions.ts";
import { DEFAULT_TIMING } from "./timing.ts";

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
export async function checkDaemonSetup(
  scienceCli: ScienceCli,
  options: Pick<ConnectOptions, "startCommand"> = {},
): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];
  /** The check being made: the one that failed, if anything below throws. */
  let checking: (typeof CHECK_NAMES)[number] = "Science CLI";
  try {
    const status = await runScienceCli(scienceCli, ["status"]);
    checks.push({ name: checking, status: "pass", message: "found" });

    checking = "Daemon";
    const endpoint = parseDaemonStatus(status, options.startCommand);
    checks.push({ name: checking, status: "pass", message: `running at ${endpoint.baseUrl}` });

    checking = "Daemon version";
    const warning = untestedVersionWarning(endpoint.version);
    checks.push(
      warning === undefined
        ? { name: checking, status: "pass", message: `${endpoint.version}, tested` }
        : { name: checking, status: "warning", message: warning },
    );

    checking = "Login";
    const { requestTimeoutMs } = DEFAULT_TIMING;
    const login = await logIn(endpoint, scienceCli, requestTimeoutMs);
    const access = new DaemonAccess(scienceCli, endpoint, login, requestTimeoutMs);
    await createDaemonHttp(access).get("/me");
    checks.push({ name: checking, status: "pass", message: "the daemon accepted a login link" });
  } catch (error) {
    if (!(error instanceof ScienceDaemonError)) throw error;
    checks.push({ name: checking, status: "failure", message: error.message });
    for (const name of CHECK_NAMES.slice(CHECK_NAMES.indexOf(checking) + 1)) {
      checks.push({
        name,
        status: "failure",
        message: `not checked, because the "${checking}" check failed. Fix that first.`,
      });
    }
  }
  return checks;
}
