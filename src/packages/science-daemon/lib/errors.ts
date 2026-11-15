/** Why an operation on the daemon failed. Callers branch on this, never on the message. */
export type ScienceDaemonErrorKind =
  /** The Science CLI could not be run, or printed something that could not be understood. */
  | "science-cli-failed"
  /** The Science CLI reports that no daemon is running. */
  | "not-running"
  /** The daemon did not accept the login link, or a login that expired could not be renewed. */
  | "login-failed"
  /** The daemon could not be reached over the network, or the connection to it was lost. */
  | "unreachable"
  /** The daemon answered a request with an error. */
  | "rejected"
  /** The daemon answered, but not in the shape this version understands. */
  | "unexpected-response";

/** Any failure of the `science-daemon` package. The message is safe to show to the user. */
export class ScienceDaemonError extends Error {
  override readonly name = "ScienceDaemonError";
  readonly kind: ScienceDaemonErrorKind;

  constructor(kind: ScienceDaemonErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.kind = kind;
  }
}
