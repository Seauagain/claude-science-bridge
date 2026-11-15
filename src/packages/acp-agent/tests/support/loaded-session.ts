import {
  type ClientContext,
  methods,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { Harness } from "./harness.ts";

/** A session the client loaded by its identifier instead of opening a new one. */
export interface LoadedSession {
  readonly sessionId: string;
  /** What the agent replayed before it answered the load, oldest first. */
  readonly history: SessionUpdate[];
  /** Sends one prompt and resolves, once the turn has stopped, with the reply's text chunks. */
  runTurn(prompt: string): Promise<{ chunks: string[]; stopReason: StopReason }>;
}

/** Loads a session in `folder`, as a client does when the user opens an existing thread. */
export async function loadSession(
  harness: Harness,
  context: ClientContext,
  sessionId: string,
  folder: string,
): Promise<LoadedSession> {
  const seenBefore = harness.updates(sessionId).length;
  await context.request(methods.agent.session.load, { sessionId, cwd: folder, mcpServers: [] });
  // Taken the moment the load is answered: the history has to be there by then.
  const history = harness
    .updates(sessionId)
    .slice(seenBefore)
    .filter((update) => update.sessionUpdate !== "available_commands_update");

  return {
    sessionId,
    history,
    async runTurn(prompt) {
      const seen = harness.updates(sessionId).length;
      const { stopReason } = await context.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      const chunks = harness
        .updates(sessionId)
        .slice(seen)
        .flatMap((update) =>
          update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
            ? [update.content.text]
            : [],
        );
      return { chunks, stopReason };
    },
  };
}

/** A piece of replayed history that is text the user typed. */
export function userText(text: string): SessionUpdate {
  return { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
}

/** A piece of replayed history that is text Claude Science replied. */
export function replyText(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}
