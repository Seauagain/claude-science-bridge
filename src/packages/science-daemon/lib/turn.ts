import { AsyncQueue } from "./async-queue.ts";
import type { ConversationState } from "./conversation-state.ts";
import type { DaemonEvent, SocketSignal } from "./socket.ts";

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
  /**
   * The turn's events, in order. Iterate once; stopping early releases the turn.
   *
   * A connection that drops during the turn is reopened without the consumer noticing: reply
   * text is never repeated, and text that was streamed in the meantime arrives late, at the
   * latest when the turn ends. Iteration fails with a ScienceDaemonError when the connection
   * cannot be reopened.
   */
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
 * Turns what the event socket reports about one conversation into the events of one turn,
 * following "Turn lifecycle" in docs/protocol.md.
 *
 * Create it once the daemon has accepted the turn's message: from then on the conversation's
 * state, when it has to be read, is the state of this turn.
 */
export class TurnTracker {
  readonly events: AsyncIterable<TurnEvent>;
  readonly #conversationId: string;
  readonly #queue: AsyncQueue<TurnEvent>;
  readonly #readState: () => Promise<ConversationState>;
  /**
   * A status that ends a turn counts only after `processing` was seen: the daemon re-sends the
   * previous turn's final status, sometimes just before the next turn starts.
   */
  #started = false;
  #ended = false;
  /** All reply text handed to the consumer so far. */
  #delivered = "";
  /**
   * Set when the socket was reopened during the turn. Streamed text no longer continues what
   * was delivered, because some of it was missed, and what a status event says may be out of
   * date. From then on the conversation's state, read over HTTP, is what counts.
   */
  #eventsMissed = false;
  /** The reads of the conversation's state, one at a time and in order. */
  #catchingUp: Promise<void> = Promise.resolve();

  /**
   * `release` runs once, when the turn ends or its consumer stops listening. `readState` reads
   * where the conversation stands; it is called only after events were missed.
   */
  constructor(
    conversationId: string,
    release: () => void,
    readState: () => Promise<ConversationState>,
  ) {
    this.#conversationId = conversationId;
    this.#queue = new AsyncQueue(release);
    this.#readState = readState;
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

  /** Feeds one signal of the event socket. */
  accept(signal: SocketSignal): void {
    if (signal.kind === "event") {
      this.#acceptEvent(signal.event);
    } else if (signal.kind === "gone") {
      this.fail(signal.error);
    } else {
      this.#eventsMissed = true;
      this.#catchUp();
    }
  }

  /** Events of other conversations and of sub-agent frames are ignored. */
  #acceptEvent(event: DaemonEvent): void {
    if (event.root_frame_id !== this.#conversationId) return;
    if (event.frame_id !== this.#conversationId) return;

    if (event.type === "text_chunk") {
      const streamed = event.block_type === "text" && typeof event.chunk === "string";
      if (streamed && !this.#eventsMissed) this.#deliver(String(event.chunk));
    } else if (event.type === "frame_update") {
      this.#acceptStatus(event);
    }
  }

  #acceptStatus(event: DaemonEvent): void {
    if (event.status === "processing") {
      this.#started = true;
      return;
    }
    if (typeof event.status !== "string") return;
    const outcome = OUTCOME_BY_STATUS[event.status];
    if (outcome === undefined) return;

    if (this.#eventsMissed) this.#catchUp();
    else if (this.#started) this.#end(outcome, event.status_description);
  }

  /** Reads the conversation's state and brings the turn up to date with it. */
  #catchUp(): void {
    this.#catchingUp = this.#catchingUp
      .then(async () => {
        if (this.#ended) return;
        const state = await this.#readState();
        this.#deliver(undeliveredText(this.#delivered, state.replyText));
        const outcome = OUTCOME_BY_STATUS[state.status];
        if (outcome !== undefined) this.#end(outcome, state.statusDescription);
      })
      .catch((error: unknown) => this.fail(error));
  }

  #deliver(text: string): void {
    if (text === "") return;
    this.#delivered += text;
    this.#queue.push({ type: "reply-text", text });
  }

  #end(outcome: TurnOutcome, detail: unknown): void {
    this.#queue.push(
      typeof detail === "string" && detail !== ""
        ? { type: "ended", outcome, detail }
        : { type: "ended", outcome },
    );
    this.#queue.end();
    this.#ended = true;
  }
}

/**
 * The part of `reply` that the consumer has not been given yet: what follows the longest end of
 * `delivered` that `reply` starts with.
 *
 * `delivered` may hold earlier messages of the same turn in front of the one `reply` is, which
 * is why it is matched at its end and not as a whole.
 */
function undeliveredText(delivered: string, reply: string): string {
  for (let overlap = Math.min(delivered.length, reply.length); overlap > 0; overlap--) {
    if (delivered.endsWith(reply.slice(0, overlap))) return reply.slice(overlap);
  }
  return reply;
}
