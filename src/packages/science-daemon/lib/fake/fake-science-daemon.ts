import type { ScienceCli } from "../science-cli.ts";
import type { JsonRecord } from "../validate.ts";
import type { ExistingConversation, FakeConversation, ReplyScript } from "./fake-conversation.ts";
import type { FakeProject } from "./fake-projects.ts";

/** A stand-in for the Claude Science daemon that implements docs/protocol.md. */
export interface FakeScienceDaemon {
  /** A Science CLI stand-in that answers `status` and `url` for this fake daemon. */
  readonly scienceCli: ScienceCli;
  /** Makes the Science CLI stand-in report the daemon as running (the default) or not running. */
  reportRunning(running: boolean): void;
  /** Makes the Science CLI stand-in report `version` instead of the version protocol.md covers. */
  reportVersion(version: string): void;
  /**
   * Answers the next logged-in request to `route` (for example `"GET /api/me"`) with `body`
   * instead of the usual response, as a daemon version with a different interface would.
   */
  respondOnce(route: string, body: unknown): void;

  /**
   * Makes every login issued so far expire: requests that carry one are answered 401 and new
   * socket handshakes are refused. Sockets that are already open stay open.
   */
  expireLogins(): void;
  /**
   * While false, the daemon treats every request as not logged in, even one that carries a login
   * it issued a moment ago. It accepts logins by default.
   */
  acceptLogins(accept: boolean): void;
  /** How many logins the daemon has issued, each in exchange for a login link. */
  loginCount(): number;
  /**
   * Makes every CSRF token issued so far stale: a write that carries one is answered 403 with
   * `code: "csrf_stale"` until the client has fetched a new token from `GET /api/csrf`.
   */
  expireCsrfTokens(): void;

  /** Creates a project, archived if asked, and returns its identifier. */
  addProject(name: string, options?: { readonly archived?: boolean }): string;
  /** Every project the daemon holds, added by the test or created by a client, oldest first. */
  projects(): FakeProject[];
  /**
   * Adds a conversation to a project as it would exist from earlier use, with its title, its
   * transcript and its last turn ended, and returns its identifier.
   */
  addConversation(projectId: string, conversation: ExistingConversation): string;
  /** Queues the script for the next message. Unscripted messages get the reply "pong". */
  onNextMessage(script: ReplyScript): void;
  /**
   * Makes a cancel end the running turn with status `cancelled` (the default) or, while false,
   * only be acknowledged: the daemon answers the cancel as usual and the reply script's
   * `cancelled` resolves, but the turn runs on until the script ends it, if it ever does. This
   * stands for a daemon that is slow to stop a reply or fails to; nothing like it was observed.
   */
  endTurnsOnCancel(end: boolean): void;
  /** Every conversation the daemon holds, added or started by a message, oldest first. */
  conversations(): FakeConversation[];
  /** The model and effort each conversation has, in the order of {@link conversations}. */
  conversationSettings(): { model: string | null; effort: string | null }[];
  /**
   * Identifiers of the conversations a cancel was requested for, oldest request first. Includes
   * requests that found no running turn.
   */
  cancelRequests(): string[];
  /** Resolves the next time a client is served messages of a conversation's transcript. */
  nextTranscriptRead(): Promise<void>;

  /** Pushes an event to every open socket, as the daemon does for the user's other activity. */
  broadcast(event: JsonRecord): void;
  /** How many event sockets are open right now. */
  eventConnectionCount(): number;
  /** Cuts every open event socket without a closing handshake. The daemon itself stays up. */
  dropEventSockets(): void;
  /** Resolves the next time a client opens an event socket. */
  nextEventSocket(): Promise<void>;
  /** Resolves the next time a ping arrives on an event socket. */
  nextPing(): Promise<void>;
  /** Makes the daemon answer pings with a pong (the default) or leave them unanswered. */
  answerPings(answer: boolean): void;

  /**
   * Makes the daemon answer requests and socket handshakes (the default) or, while false, accept
   * their connections and then say nothing, as a daemon that hangs does. What arrives meanwhile
   * is never answered, also not once the daemon answers again. Event sockets that are open
   * already are not affected: see {@link answerPings} and {@link dropEventSockets}. The Science
   * CLI stand-in goes on reporting the daemon as running.
   */
  answerRequests(answer: boolean): void;

  /**
   * Stops the daemon as when its process exits: event sockets drop, requests find nobody
   * listening, the Science CLI stand-in reports it as not running, and logins are forgotten.
   * Projects and conversations are kept.
   */
  stop(): Promise<void>;
  /** Starts a stopped daemon again. It listens on a new port. */
  start(): Promise<void>;
  /** Stops the daemon for good. */
  close(): Promise<void>;
}
