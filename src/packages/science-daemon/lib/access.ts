import { type DaemonEndpoint, locateDaemon } from "./endpoint.ts";
import { ScienceDaemonError } from "./errors.ts";
import { type Login, logIn, refreshCsrfToken } from "./login.ts";
import type { ScienceCli } from "./science-cli.ts";

/** How every error about a login that could not be replaced begins. */
const LOGIN_NOT_RENEWED = "The login to Claude Science expired and could not be renewed.";

/** The error for a new login that the daemon turned away just like the one it replaced. */
export function newLoginRejected(): ScienceDaemonError {
  return new ScienceDaemonError(
    "login-failed",
    `${LOGIN_NOT_RENEWED} Claude Science turned away a new login as well. ` +
      "Run `csbridge doctor` to check the login, then try again.",
  );
}

/**
 * Where the daemon is and the login it accepts, kept current for everything that talks to it.
 * Requests and the event socket read both from here each time, so a renewed login reaches all
 * of them.
 */
export class DaemonAccess {
  readonly #scienceCli: ScienceCli;
  #endpoint: DaemonEndpoint;
  #login: Login;
  #renewal: Promise<Login> | undefined;

  constructor(scienceCli: ScienceCli, endpoint: DaemonEndpoint, login: Login) {
    this.#scienceCli = scienceCli;
    this.#endpoint = endpoint;
    this.#login = login;
  }

  get endpoint(): DaemonEndpoint {
    return this.#endpoint;
  }

  get login(): Login {
    return this.#login;
  }

  /**
   * Asks the Science CLI where the daemon is now: one that was restarted may listen on another
   * port. Fails with `not-running` when there is none.
   */
  async relocate(): Promise<void> {
    this.#endpoint = await locateDaemon(this.#scienceCli);
  }

  /**
   * Logs in again because the daemon stopped accepting `rejected`, and returns the login to use
   * from now on. However many callers were turned away with the same login, one login is made.
   */
  renewLogin(rejected: Login): Promise<Login> {
    // Someone else was turned away with the same login first and has replaced it already.
    if (rejected !== this.#login) return Promise.resolve(this.#login);
    this.#renewal ??= logIn(this.#endpoint, this.#scienceCli)
      .then((login) => {
        this.#login = login;
        return login;
      }, explainFailedRenewal)
      .finally(() => {
        this.#renewal = undefined;
      });
    return this.#renewal;
  }

  /**
   * Fetches a new CSRF token because the daemon called the one in `rejected` stale, and returns
   * the login to use from now on.
   */
  async refreshCsrfToken(rejected: Login): Promise<Login> {
    if (rejected !== this.#login) return this.#login;
    const refreshed = await refreshCsrfToken(this.#endpoint, rejected);
    // A whole new login made in the meantime is newer than a refreshed token on the old one.
    if (rejected === this.#login) this.#login = refreshed;
    return this.#login;
  }
}

/**
 * A login that fails in the middle of a session needs the context that it was a renewal. A
 * daemon that cannot be reached is a different problem and is reported as itself.
 */
function explainFailedRenewal(error: unknown): never {
  if (!(error instanceof ScienceDaemonError) || error.kind === "unreachable") throw error;
  throw new ScienceDaemonError("login-failed", `${LOGIN_NOT_RENEWED} ${error.message}`, {
    cause: error,
  });
}
