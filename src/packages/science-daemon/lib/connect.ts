import { randomUUID } from "node:crypto";
import { DaemonAccess } from "./access.ts";
import { readConversationState } from "./conversation-state.ts";
import { locateDaemon } from "./endpoint.ts";
import { createDaemonHttp, type DaemonHttp } from "./http.ts";
import { logIn } from "./login.ts";
import { listProjects, type Project } from "./projects.ts";
import type { ScienceCli } from "./science-cli.ts";
import { type DaemonSocket, openDaemonSocket, type SocketSignal } from "./socket.ts";
import { untestedVersionWarning } from "./tested-versions.ts";
import { type ConnectionTiming, DEFAULT_TIMING } from "./timing.ts";
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
   * Starts a new conversation in a project with its first message, and with it the first turn.
   *
   * @throws ScienceDaemonError when the daemon refuses the message or cannot be reached.
   */
  startConversation(projectId: string, message: string): Promise<Turn>;
  /**
   * Sends a further message to an existing conversation, and with it starts the next turn.
   * The conversation's previous turn must have ended.
   *
   * @throws ScienceDaemonError when the daemon refuses the message or cannot be reached.
   */
  sendMessage(conversationId: string, message: string): Promise<Turn>;
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

/** Signals of the event socket kept while a message has not been accepted yet. */
const MAX_BUFFERED_SIGNALS = 1000;

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

  return {
    async listProjects() {
      await socket.ready();
      return listProjects(http);
    },
    startConversation: (projectId, message) =>
      startTurn(http, socket, async () => {
        const call = "POST /projects/<id>/request";
        const response = expectRecord(
          await http.post(`/projects/${encodeURIComponent(projectId)}/request`, {
            input_data: { request: message },
          }),
          call,
        );
        return expectString(response, "root_frame_id", call);
      }),
    sendMessage: (conversationId, message) =>
      startTurn(http, socket, async () => {
        const frameCall = "GET /frames/<id>";
        const frame = expectRecord(
          await http.get(`/frames/${encodeURIComponent(conversationId)}?shallow=true`),
          frameCall,
        );
        await http.post("/request", {
          target_agent: expectString(frame, "agent_name", frameCall),
          root_frame_id: conversationId,
          frame_id: conversationId,
          plan_mode: false,
          intent_id: randomUUID(),
          input_data: { request: message },
        });
        return conversationId;
      }),
    close: () => socket.close(),
  };
}

/**
 * Sends a message and follows the turn it starts. `send` resolves, once the daemon has accepted
 * the message, to the identifier of the conversation it went to.
 */
async function startTurn(
  http: DaemonHttp,
  socket: DaemonSocket,
  send: () => Promise<string>,
): Promise<Turn> {
  // A turn cannot be followed without the socket, and after a long outage only reopening it
  // finds out where the daemon is now.
  await socket.ready();
  // The turn's first events can arrive before the response that accepts the message, and for a
  // new conversation before its identifier is known. So listen first, and hand what arrived to
  // the turn once the message is accepted.
  const buffered: SocketSignal[] = [];
  let deliver = (signal: SocketSignal) => {
    if (buffered.length < MAX_BUFFERED_SIGNALS) buffered.push(signal);
  };
  const stopListening = socket.onSignal((signal) => deliver(signal));

  try {
    const conversationId = await send();
    const tracker = new TurnTracker(conversationId, stopListening, () =>
      readConversationState(http, conversationId),
    );
    for (const signal of buffered) tracker.accept(signal);
    deliver = (signal) => tracker.accept(signal);
    return followedTurn(http, conversationId, tracker);
  } catch (error) {
    stopListening();
    throw error;
  }
}

/** The turn that `tracker` follows, as the package's callers see it. */
function followedTurn(http: DaemonHttp, conversationId: string, tracker: TurnTracker): Turn {
  return {
    conversationId,
    events: tracker.events,
    cancel() {
      if (tracker.ended) return;
      // Not awaited: the daemon confirms through the turn's events, and a caller reacting to the
      // user's cancel has nobody to hand a failure to except whoever reads those events.
      http
        .post(`/frames/${encodeURIComponent(conversationId)}/cancel`)
        .catch((error: unknown) => tracker.fail(error));
    },
  };
}
