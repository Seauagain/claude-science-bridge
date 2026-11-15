import { ScienceDaemonError } from "./errors.ts";

/**
 * Resolves like `pending`, unless `cancel` is aborted first: then it rejects with a `cancelled`
 * error at once, without waiting for `pending`.
 *
 * This is for what comes before a message is sent, so that a caller who cancels in that time
 * gets an answer right away and the message never leaves.
 */
export function unlessCancelled<T>(cancel: AbortSignal, pending: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const giveUp = () =>
      reject(
        new ScienceDaemonError(
          "cancelled",
          "The message was cancelled before it was sent to Claude Science.",
        ),
      );
    if (cancel.aborted) giveUp();
    cancel.addEventListener("abort", giveUp, { once: true });
    // `pending` is listened to even when it lost, so that its failure does not go unhandled.
    pending.then(resolve, reject).finally(() => cancel.removeEventListener("abort", giveUp));
  });
}
