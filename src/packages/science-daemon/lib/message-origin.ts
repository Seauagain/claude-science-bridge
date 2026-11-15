import type { JsonRecord } from "./validate.ts";

/**
 * Whether the daemon added a message itself. It files such messages under the user's role: its
 * notices, the summary that stands in for a part of a long transcript, and the mark between
 * tasks. The user typed none of them. See "Conversations and their messages" in
 * docs/protocol.md.
 */
export function addedByDaemon(message: JsonRecord): boolean {
  return (
    message._harness_notice === true ||
    message._rolling_summary !== undefined ||
    message._task_boundary !== undefined
  );
}
