import { ScienceDaemonError } from "./errors.ts";

/** What to tell the user about a daemon that took a request and then said nothing. */
export function noAnswerMessage(timeoutMs: number): string {
  return (
    `Claude Science did not answer within ${timeoutMs / 1000} seconds. ` +
    "Check that it is still running (`claude-science status`) and that its page in the browser " +
    "still responds; restart it if it does not."
  );
}

/**
 * Runs one HTTP exchange with the daemon and gives it `timeoutMs` to finish. `exchange` hands
 * the signal to `fetch` and reads what it needs of the response before it returns, so that the
 * limit covers the body as well as the headers.
 *
 * @throws ScienceDaemonError with kind `unreachable` when the daemon cannot be reached or does
 *   not answer in time. `purpose` finishes the sentence "Could not reach Claude Science ...".
 */
export async function withinTimeLimit<T>(
  timeoutMs: number,
  exchange: (signal: AbortSignal) => Promise<T>,
  purpose = "",
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await exchange(signal);
  } catch (cause) {
    throw new ScienceDaemonError(
      "unreachable",
      signal.aborted
        ? noAnswerMessage(timeoutMs)
        : `Could not reach Claude Science${purpose}. ` +
            "Check that it is still running (`claude-science status`).",
      { cause },
    );
  }
}
