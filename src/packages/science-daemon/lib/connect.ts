import { randomUUID } from "node:crypto";
import { DaemonAccess } from "./access.ts";
import { unlessCancelled } from "./cancellation.ts";
import { readConversationState, readInputRequests } from "./conversation-state.ts";
import { type Conversation, listConversations } from "./conversations.ts";
import { locateDaemon } from "./endpoint.ts";
import { ScienceDaemonError } from "./errors.ts";
import { createDaemonHttp, type DaemonHttp } from "./http.ts";
import { answerInputRequests, type InputAnswer, type InputRequest } from "./input-requests.ts";
import { logIn } from "./login.ts";
import {
  type ConversationSettings,
  listModels,
  type ModelCatalog,
  readConversationSettings,
} from "./models.ts";
import { createProject, listProjects, type Project } from "./projects.ts";
import type { ScienceCli } from "./science-cli.ts";
import { type DaemonSocket, openDaemonSocket, type SocketSignal } from "./socket.ts";
import { untestedVersionWarning } from "./tested-versions.ts";
import { type ConnectionTiming, DEFAULT_TIMING } from "./timing.ts";
import { readTranscript, type TranscriptEntry } from "./transcript.ts";
import { type Turn, TurnTracker } from "./turn.ts";
import { expectRecord, expectString } from "./validate.ts";

/**
 * A logged-in connection to the local Claude Science daemon.
 *
 * The connection looks after itself. It logs in again when the daemon stops accepting the login,
 * keeps its event socket alive, and reopens the socket when it drops. A method fails only when
 * that did not help, and the connection remains usable afterwards: once the daemon is back, the
 * next call finds it again, even on another port.
 */
export interface ScienceDaemon {
  /**
   * Lists the user's projects that are not archived, in the daemon's order.
   *
   * @throws ScienceDaemonError when the daemon cannot be reached or answers unexpectedly.
   */
  listProjects(): Promise<Project[]>;
  /**
   * Creates a project with the given name and returns it. The daemon does not keep names
   * unique: a second project of the same name is created without complaint.
   *
   * @throws ScienceDaemonError when the daemon refuses, cannot be reached or answers
   *   unexpectedly.
   */
  createProject(name: string): Promise<Project>;
  /**
   * Lists the conversations of a project that the user sees, newest first. Conversations the
   * daemon hides and the project's other frames, such as its uploads, are left out.
   *
   * @throws ScienceDaemonError when the daemon cannot be reached, refuses the request (as it
   *   may for a project it does not know) or answers unexpectedly.
   */
  listConversations(projectId: string): Promise<Conversation[]>;
  /**
   * Reads what a conversation's transcript shows the user, oldest first: what the user typed,
   * what Claude Science replied, and the tools it used. Messages the daemon added itself,
   * reasoning, tool results and images are left out.
   *
   * @throws ScienceDaemonError with kind `not-found` when the daemon has no such conversation,
   *   and otherwise when it cannot be reached or answers unexpectedly.
   */
  readTranscript(conversationId: string): Promise<TranscriptEntry[]>;
  /**
   * Lists the models the daemon offers, with the effort levels each takes and the defaults.
   *
   * @throws ScienceDaemonError when the daemon cannot be reached or answers unexpectedly.
   */
  listModels(): Promise<ModelCatalog>;
  /**
   * Reads the model and effort a conversation has.
   *
   * @throws ScienceDaemonError with kind `not-found` when the daemon has no such conversation.
   */
  conversationSettings(conversationId: string): Promise<ConversationSettings>;
  /**
   * Starts a new conversation in a project with its first message, and with it the first turn.
   * `settings` names the model and effort the conversation gets; what is left out is the
   * daemon's default.
   * Aborting `cancel` stops the reply: see {@link Turn.events}.
   *
   * @throws ScienceDaemonError when the daemon refuses the message or cannot be reached, and
   *   with kind `cancelled` when `cancel` was aborted before the message was sent. The message
   *   is then not sent at all, and the rejection does not wait for the connection.
   */
  startConversation(
    projectId: string,
    message: string,
    cancel: AbortSignal,
    settings?: ConversationSettings,
  ): Promise<Turn>;
  /**
   * Sends a further message to an existing conversation, and with it starts the next turn.
   * The conversation's previous turn must have ended. Aborting `cancel` stops the reply: see
   * {@link Turn.events}. A model named in `settings` is used from this message on; an effort is
   * not, because the daemon keeps the effort a conversation started with.
   *
   * @throws ScienceDaemonError as {@link ScienceDaemon.startConversation} does, and with kind
   *   `awaiting-answer` when the daemon takes no message because it waits for an answer that
   *   {@link ScienceDaemon.waitingTurn} does not report, as for a request of a sub-agent.
   */
  sendMessage(
    conversationId: string,
    message: string,
    cancel: AbortSignal,
    settings?: ConversationSettings,
  ): Promise<Turn>;
  /**
   * Follows the turn of a conversation that stopped to ask the user for approvals or answers
   * nobody has given yet. The turn's first event names them, and the turn goes on once they
   * are answered. Resolves to nothing for a conversation that waits for no such thing. A
   * conversation that does takes no further message until it has its answers.
   *
   * @throws ScienceDaemonError as {@link ScienceDaemon.sendMessage} does.
   */
  waitingTurn(conversationId: string, cancel: AbortSignal): Promise<Turn | undefined>;
  /**
   * Gives the daemon the user's answers to input requests of a conversation's turn, which then
   * goes on. Resolves to false when the requests had their answers already, from the browser
   * for example: these answers then changed nothing.
   *
   * @throws ScienceDaemonError when the daemon refuses the answers or cannot be reached.
   */
  answerInputRequests(conversationId: string, answers: readonly InputAnswer[]): Promise<boolean>;
  /**
   * Closes the connection for good and stops every attempt to restore it. Turns still running
   * stop producing events.
   */
  close(): void;
}

/** What {@link connectScienceDaemon} needs. */
export interface ConnectOptions {
  /** Runs the Science CLI. See {@link ScienceCli}. */
  readonly scienceCli: ScienceCli;
  /**
   * The command that starts the daemon on this machine, named in the error for a daemon that is
   * not running. Defaults to `claude-science serve`; set it where the daemon is started through
   * a launcher of the user's own.
   */
  readonly startCommand?: string;
  /**
   * Receives a one-line warning about something that does not stop the connection: today, a
   * daemon version this release was not tested with. Without it such warnings are not reported.
   */
  readonly onWarning?: (message: string) => void;
  /** Overrides for the connection's timing. Leave it out to get the production values. */
  readonly timing?: Partial<ConnectionTiming>;
}

/**
 * Finds the running daemon, logs in and opens the event connection.
 *
 * @throws ScienceDaemonError with kind `not-running`, `science-cli-failed`, `login-failed`,
 *   `unreachable` or `unexpected-response`.
 */
export async function connectScienceDaemon(options: ConnectOptions): Promise<ScienceDaemon> {
  const endpoint = await locateDaemon(options.scienceCli, options.startCommand);
  const versionWarning = untestedVersionWarning(endpoint.version);
  if (versionWarning !== undefined) options.onWarning?.(versionWarning);
  const timing: ConnectionTiming = { ...DEFAULT_TIMING, ...options.timing };
  const login = await logIn(endpoint, options.scienceCli, timing.requestTimeoutMs);
  const access = new DaemonAccess(
    options.scienceCli,
    endpoint,
    login,
    timing.requestTimeoutMs,
    options.startCommand,
  );
  const http = createDaemonHttp(access);
  const me = expectRecord(await http.get("/me"), "GET /me");
  const socket = await openDaemonSocket(access, expectString(me, "user_id", "GET /me"), timing);
  const channel: TurnChannel = { http, socket, cancelTimeoutMs: timing.cancelTimeoutMs };

  return {
    async listProjects() {
      await socket.ready();
      return listProjects(http);
    },
    async createProject(name) {
      await socket.ready();
      return createProject(http, name);
    },
    async listConversations(projectId) {
      await socket.ready();
      return listConversations(http, projectId);
    },
    async readTranscript(conversationId) {
      await socket.ready();
      return readTranscript(http, conversationId);
    },
    async listModels() {
      await socket.ready();
      return listModels(http);
    },
    async conversationSettings(conversationId) {
      await socket.ready();
      return readConversationSettings(http, conversationId);
    },
    startConversation: (projectId, message, cancel, settings = {}) =>
      startTurn(channel, cancel, async () => {
        const call = "POST /projects/<id>/request";
        const response = expectRecord(
          await http.post(`/projects/${encodeURIComponent(projectId)}/request`, {
            input_data: { request: message },
            ...settings,
          }),
          call,
        );
        return expectString(response, "root_frame_id", call);
      }),
    sendMessage: (conversationId, message, cancel, settings = {}) =>
      startTurn(channel, cancel, async () => {
        const frameCall = "GET /frames/<id>";
        const frame = expectRecord(
          await http.get(`/frames/${encodeURIComponent(conversationId)}?shallow=true`),
          frameCall,
        );
        await http
          .post("/request", {
            target_agent: expectString(frame, "agent_name", frameCall),
            root_frame_id: conversationId,
            frame_id: conversationId,
            plan_mode: false,
            intent_id: randomUUID(),
            input_data: { request: message },
            ...(settings.model === undefined ? {} : { model: settings.model }),
          })
          .catch(rethrowAwaitingAnswer);
        return conversationId;
      }),
    waitingTurn: (conversationId, cancel) =>
      followTurn(channel, cancel, async () => {
        const pending = await readInputRequests(http, conversationId);
        return pending.length === 0 ? undefined : { conversationId, pending };
      }),
    async answerInputRequests(conversationId, answers) {
      await socket.ready();
      return answerInputRequests(http, conversationId, answers);
    },
    close: () => socket.close(),
  };
}

/**
 * Turns the daemon's refusal of a message for a conversation that waits for an answer into an
 * error that says what to do. See "Input requests" in docs/protocol.md.
 */
function rethrowAwaitingAnswer(error: unknown): never {
  if (
    error instanceof ScienceDaemonError &&
    error.kind === "rejected" &&
    error.message.includes("answer the pending question")
  ) {
    throw new ScienceDaemonError(
      "awaiting-answer",
      "Claude Science is waiting for an answer to something it asked, and csbridge cannot " +
        "show what it is. Answer it in Claude Science, then send your message again.",
      { cause: error },
    );
  }
  throw error;
}

/** What sending a message and following its turn needs of the connection. */
interface TurnChannel {
  readonly http: DaemonHttp;
  readonly socket: DaemonSocket;
  /** See {@link ConnectionTiming.cancelTimeoutMs}. */
  readonly cancelTimeoutMs: number;
}

/**
 * Sends a message and follows the turn it starts. `send` resolves, once the daemon has accepted
 * the message, to the identifier of the conversation it went to. Aborting `cancel` stops the
 * turn.
 */
function startTurn(
  channel: TurnChannel,
  cancel: AbortSignal,
  send: () => Promise<string>,
): Promise<Turn> {
  return followTurn(channel, cancel, async () => ({ conversationId: await send(), pending: [] }));
}

/** The conversation whose turn is to be followed, and what it is waiting on from the start. */
interface TurnStart {
  readonly conversationId: string;
  readonly pending: readonly InputRequest[];
}

/**
 * Follows a turn from the moment `begin` has run, missing none of its events. `begin` resolves
 * to the turn's conversation, or to nothing when there turns out to be no turn to follow.
 */
function followTurn(
  channel: TurnChannel,
  cancel: AbortSignal,
  begin: () => Promise<TurnStart>,
): Promise<Turn>;
function followTurn(
  channel: TurnChannel,
  cancel: AbortSignal,
  begin: () => Promise<TurnStart | undefined>,
): Promise<Turn | undefined>;
async function followTurn(
  { http, socket, cancelTimeoutMs }: TurnChannel,
  cancel: AbortSignal,
  begin: () => Promise<TurnStart | undefined>,
): Promise<Turn | undefined> {
  // A turn cannot be followed without the socket, and after a long outage only reopening it
  // finds out where the daemon is now. That can take a while: a caller that cancels meanwhile
  // is answered at once, and its message is not sent.
  await unlessCancelled(cancel, socket.ready());
  // The turn's first events can arrive before the response that accepts the message, and for a
  // new conversation before its identifier is known. So listen first, and hand what arrived to
  // the turn once the message is accepted.
  //
  // Everything is kept, however much arrives: one socket carries all of the user's activity,
  // and a signal left out could be the one that starts or ends this turn, which would then
  // never end. The buffer is bounded in time instead, because the daemon gets
  // `requestTimeoutMs` to answer each request that `send` makes.
  const buffered: SocketSignal[] = [];
  let deliver = (signal: SocketSignal) => {
    buffered.push(signal);
  };
  const stopListening = socket.onSignal((signal) => deliver(signal));

  try {
    const start = await begin();
    if (start === undefined) {
      stopListening();
      return undefined;
    }
    const { conversationId, pending } = start;
    const tracker = new TurnTracker(
      conversationId,
      cancel,
      {
        release: stopListening,
        readState: () => readConversationState(http, conversationId),
        requestCancel: () => http.post(`/frames/${encodeURIComponent(conversationId)}/cancel`),
        cancelTimeoutMs,
      },
      pending,
    );
    for (const signal of buffered) tracker.accept(signal);
    deliver = (signal) => tracker.accept(signal);
    return { conversationId, events: tracker.events };
  } catch (error) {
    stopListening();
    throw error;
  }
}
