import { AsyncQueue } from "./async-queue.ts";
import type { DaemonEvent } from "./socket.ts";

/** How a turn ended. */
export type TurnOutcome =
  /** The reply is finished. */
  | "completed"
  /** The reply was stopped on request. */
  | "cancelled"
  /** The daemon gave up on the reply. */
  | "failed"
  /** The daemon stopped to ask the user something; the next message answers it. */
  | "waiting-for-user";

/** One thing that happened during a turn. `ended` is always the last event. */
export type TurnEvent =
  | { readonly type: "reply-text"; readonly text: string }
  | { readonly type: "ended"; readonly outcome: TurnOutcome; readonly detail?: string };

/** One user message and everything the daemon does in response. */
export interface Turn {
  /** The conversation the turn belongs to. */
  readonly conversationId: string;
  /** The turn's events, in order. Iterate once; stopping early releases the turn. */
  readonly events: AsyncIterable<TurnEvent>;
  /**
   * Asks the daemon to stop the reply. The turn then ends with outcome `cancelled`, unless it
   * ended some other way first. Does nothing once the turn has ended.
   *
   * Returns at once. If the daemon cannot be asked, `events` fails with a ScienceDaemonError.
   */
  cancel(): void;
}

/** Frame statuses that end a turn. See "REST endpoints used" in docs/protocol.md. */
const OUTCOME_BY_STATUS: Readonly<Record<string, TurnOutcome>> = {
  completed: "completed",
  success: "completed",
  replaced: "completed",
  cancelled: "cancelled",
  failed: "failed",
  awaiting_user_response: "waiting-for-user",
  awaiting_plan_approval: "waiting-for-user",
};

/**
 * Turns the daemon's raw events for one conversation into the events of one turn, following
 * "Turn lifecycle" in docs/protocol.md.
 */
export class TurnTracker {
  readonly events: AsyncIterable<TurnEvent>;
  readonly #conversationId: string;
  readonly #queue: AsyncQueue<TurnEvent>;
  /**
   * A status that ends a turn counts only after `processing` was seen: the daemon re-sends the
   * previous turn's final status, sometimes just before the next turn starts.
   */
  #started = false;
  #ended = false;

  /** `release` runs once, when the turn ends or its consumer stops listening. */
  constructor(conversationId: string, release: () => void) {
    this.#conversationId = conversationId;
    this.#queue = new AsyncQueue(release);
    this.events = this.#queue;
  }

  /** Whether the daemon has reported the end of the turn. */
  get ended(): boolean {
    return this.#ended;
  }

  /** Ends the turn's events with `error`. Does nothing once the turn has ended. */
  fail(error: unknown): void {
    this.#queue.fail(error);
  }

  /** Feeds one raw event. Events of other conversations and of sub-agent frames are ignored. */
  accept(event: DaemonEvent): void {
    if (event.root_frame_id !== this.#conversationId) return;
    if (event.frame_id !== this.#conversationId) return;

    if (event.type === "text_chunk") {
      if (event.block_type === "text" && typeof event.chunk === "string" && event.chunk !== "") {
        this.#queue.push({ type: "reply-text", text: event.chunk });
      }
    } else if (event.type === "frame_update") {
      this.#acceptStatus(event);
    }
  }

  #acceptStatus(event: DaemonEvent): void {
    if (event.status === "processing") {
      this.#started = true;
      return;
    }
    if (!this.#started || typeof event.status !== "string") return;
    const outcome = OUTCOME_BY_STATUS[event.status];
    if (outcome === undefined) return;

    const detail = event.status_description;
    this.#queue.push(
      typeof detail === "string" && detail !== ""
        ? { type: "ended", outcome, detail }
        : { type: "ended", outcome },
    );
    this.#queue.end();
    this.#ended = true;
  }
}
