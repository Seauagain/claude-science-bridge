import { AsyncQueue } from "./async-queue.ts";
import type { ConversationState } from "./conversation-state.ts";
import { type InputRequest, parseInputRequests } from "./input-requests.ts";
import type { DaemonEvent, SocketSignal } from "./socket.ts";
import type { ConnectionTiming } from "./timing.ts";

/** How a turn ended. */
export type TurnOutcome =
  /** The reply is finished. */
  | "completed"
  /** The reply was stopped on request. */
  | "cancelled"
  /** The daemon gave up on the reply. */
  | "failed"
  /** The daemon stopped to ask the user something in its reply; the next message answers it. */
  | "waiting-for-user";

/** One thing that happened during a turn. `ended` is always the last event. */
export type TurnEvent =
  | { readonly type: "reply-text"; readonly text: string }
  /**
   * The daemon asks the user for approvals or answers, and the turn goes on once it has them:
   * through `answerInputRequests`, or from the user in Claude Science itself. Each request is
   * reported once.
   */
  | { readonly type: "input-requested"; readonly requests: readonly InputRequest[] }
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
   *
   * Once the caller has aborted the `cancel` signal the message was sent with, the daemon is
   * asked to stop the reply, and the only event still to come is the end of the turn, with
   * outcome `cancelled`. It comes when the daemon reports the end, at once when the daemon
   * cannot be asked, and otherwise when the connection's `cancelTimeoutMs` has passed. That
   * holds however the turn really ended, a failure included, and it holds for a reply that was
   * complete before the daemon could stop it: the caller stopped listening to it all the same.
   * Iteration no longer fails.
   */
  readonly events: AsyncIterable<TurnEvent>;
}

/** What a {@link TurnTracker} needs from the connection its turn runs on. */
export interface TurnConnection {
  /** Runs once, when the turn ends or its consumer stops listening. */
  release(): void;
  /** Reads where the conversation stands. Called only after events were missed. */
  readState(): Promise<ConversationState>;
  /** Asks the daemon to stop the turn. */
  requestCancel(): Promise<unknown>;
  /** See {@link ConnectionTiming.cancelTimeoutMs}. */
  readonly cancelTimeoutMs: number;
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
  readonly #connection: TurnConnection;
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
  /** Runs out when a cancelled turn has waited long enough for the daemon to end it. */
  #cancelDeadline: NodeJS.Timeout | undefined;
  /** The input requests the consumer has been told about. */
  readonly #asked = new Set<string>();

  /**
   * Aborting `cancel` stops the turn. It may be aborted already. `pending` are input requests
   * the conversation is waiting on from the start, for a turn that is followed from where it
   * stopped to ask.
   */
  constructor(
    conversationId: string,
    cancel: AbortSignal,
    connection: TurnConnection,
    pending: readonly InputRequest[] = [],
  ) {
    this.#conversationId = conversationId;
    this.#connection = connection;
    const stop = () => this.#stop();
    this.#queue = new AsyncQueue(() => {
      cancel.removeEventListener("abort", stop);
      clearTimeout(this.#cancelDeadline);
      connection.release();
    });
    this.events = this.#eventsUntilCancelled(cancel);
    // A turn that is followed from where it stopped to ask has started long ago. No message
    // starts it, so there is no earlier turn whose final status the daemon would send again.
    this.#started = pending.length > 0;
    this.#ask(pending);
    if (cancel.aborted) stop();
    else cancel.addEventListener("abort", stop, { once: true });
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

  /**
   * Events of other conversations are ignored, and of the conversation's sub-agent frames all
   * but what they ask the user.
   */
  #acceptEvent(event: DaemonEvent): void {
    if (event.root_frame_id !== this.#conversationId) return;
    if (event.frame_id !== this.#conversationId) {
      if (event.type === "frame_update" && !this.#eventsMissed) {
        this.#ask(parseInputRequests(event.pending_input_requests, frameIdOf(event)));
      }
      return;
    }

    if (event.type === "text_chunk") {
      // Reasoning text (`block_type: "thinking"`) is not part of the reply.
      const streamed = event.block_type === "text" && typeof event.chunk === "string";
      if (streamed && !this.#eventsMissed) this.#deliver(String(event.chunk));
    } else if (event.type === "frame_update") {
      this.#acceptStatus(event);
    }
    // `text_reset` is left unhandled on purpose. It tells a client to discard the text streamed
    // so far because the reply starts over, and the consumer cannot do that: ACP has no way to
    // take back text the client has been sent. The restarted reply follows what was delivered.
  }

  #acceptStatus(event: DaemonEvent): void {
    const requests = parseInputRequests(event.pending_input_requests, frameIdOf(event));
    if (event.status === "processing") {
      this.#started = true;
      // An approval the daemon waits for while the turn runs on.
      if (!this.#eventsMissed) this.#ask(requests);
      return;
    }
    if (typeof event.status !== "string") return;
    const outcome = OUTCOME_BY_STATUS[event.status];
    if (outcome === undefined) return;

    if (this.#eventsMissed) this.#catchUp();
    else if (this.#started) this.#settle(outcome, event.status_description, requests);
  }

  /**
   * Takes a status that ends a turn. With input requests pending the turn has only stopped to
   * ask: it goes on once they are answered, and what ends it comes after that. The daemon
   * sends that status more than once, which changes nothing here.
   */
  #settle(outcome: TurnOutcome, detail: unknown, requests: readonly InputRequest[]): void {
    if (outcome === "waiting-for-user" && requests.length > 0) this.#ask(requests);
    else this.#end(outcome, detail);
  }

  /** Tells the consumer about the input requests it has not been told about yet. */
  #ask(requests: readonly InputRequest[]): void {
    const fresh = requests.filter(({ requestId }) => !this.#asked.has(requestId));
    if (fresh.length === 0) return;
    for (const { requestId } of fresh) this.#asked.add(requestId);
    this.#queue.push({ type: "input-requested", requests: fresh });
  }

  /** Reads the conversation's state and brings the turn up to date with it. */
  #catchUp(): void {
    this.#catchingUp = this.#catchingUp
      .then(async () => {
        if (this.#ended) return;
        const state = await this.#connection.readState();
        this.#deliver(undeliveredText(this.#delivered, state.replyText));
        const outcome = OUTCOME_BY_STATUS[state.status];
        if (outcome === undefined) this.#ask(state.inputRequests);
        else this.#settle(outcome, state.statusDescription, state.inputRequests);
      })
      .catch((error: unknown) => this.fail(error));
  }

  /**
   * The turn's events as its consumer gets them: all of them until `cancel` is aborted, and
   * from then on only the turn's end, as `cancelled`. See {@link Turn.events}.
   */
  async *#eventsUntilCancelled(cancel: AbortSignal): AsyncGenerator<TurnEvent> {
    const cancelled: TurnEvent = { type: "ended", outcome: "cancelled" };
    try {
      for await (const event of this.#queue) {
        if (!cancel.aborted) yield event;
        else if (event.type === "ended") yield cancelled;
      }
    } catch (error) {
      if (!cancel.aborted) throw error;
      yield cancelled;
    }
  }

  /** Asks the daemon to stop the turn, because the caller cancelled it. */
  #stop(): void {
    const endAsCancelled = () => this.#end("cancelled", undefined);
    // The daemon confirms through the turn's events. A caller that cancelled must not wait for
    // that without limit: the daemon may take the request and never end the turn, or never
    // answer the request at all.
    this.#cancelDeadline = setTimeout(endAsCancelled, this.#connection.cancelTimeoutMs);
    // When the daemon cannot even be asked, the turn is over for the caller all the same, who
    // asked for exactly that: the failure is not reported.
    this.#connection.requestCancel().catch(endAsCancelled);
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

/** The frame an event is about, which holds the input requests the event lists. */
function frameIdOf(event: DaemonEvent): string | undefined {
  return typeof event.frame_id === "string" ? event.frame_id : undefined;
}
