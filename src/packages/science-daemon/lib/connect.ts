import { locateDaemon } from "./endpoint.ts";
import { createDaemonHttp } from "./http.ts";
import { logIn } from "./login.ts";
import { listProjects, type Project } from "./projects.ts";
import type { ScienceCli } from "./science-cli.ts";
import { type DaemonEvent, openDaemonSocket } from "./socket.ts";
import { type Turn, TurnTracker } from "./turn.ts";
import { expectRecord, expectString } from "./validate.ts";

/** A logged-in connection to the local Claude Science daemon. */
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
  /** Closes the connection. Turns still running stop producing events. */
  close(): void;
}

/** What {@link connectScienceDaemon} needs. */
export interface ConnectOptions {
  /** Runs the Science CLI. See {@link ScienceCli}. */
  readonly scienceCli: ScienceCli;
}

/** Events kept while a new conversation's identifier is not known yet. */
const MAX_BUFFERED_EVENTS = 1000;

/**
 * Finds the running daemon, logs in and opens the event connection.
 *
 * @throws ScienceDaemonError with kind `not-running`, `science-cli-failed`, `login-failed`,
 *   `unreachable` or `unexpected-response`.
 */
export async function connectScienceDaemon(options: ConnectOptions): Promise<ScienceDaemon> {
  const endpoint = await locateDaemon(options.scienceCli);
  const login = await logIn(endpoint, options.scienceCli);
  const http = createDaemonHttp(endpoint, login);
  const me = expectRecord(await http.get("/me"), "GET /me");
  const socket = await openDaemonSocket(endpoint, login, expectString(me, "user_id", "GET /me"));

  return {
    listProjects: () => listProjects(http),
    async startConversation(projectId, message) {
      const call = "POST /projects/<id>/request";
      // The turn's first events can arrive before the response that names the conversation,
      // so listen first and sort the events out once the identifier is known.
      const buffered: DaemonEvent[] = [];
      let deliver = (event: DaemonEvent) => {
        if (buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event);
      };
      const stopListening = socket.onEvent((event) => deliver(event));

      try {
        const response = expectRecord(
          await http.post(`/projects/${encodeURIComponent(projectId)}/request`, {
            input_data: { request: message },
          }),
          call,
        );
        const conversationId = expectString(response, "root_frame_id", call);
        const tracker = new TurnTracker(conversationId, stopListening);
        for (const event of buffered) tracker.accept(event);
        deliver = (event) => tracker.accept(event);
        return { conversationId, events: tracker.events };
      } catch (error) {
        stopListening();
        throw error;
      }
    },
    close: () => socket.close(),
  };
}
