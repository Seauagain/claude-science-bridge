import {
  type AgentContext,
  methods,
  type PromptResponse,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { ScienceDaemon, ToolEvent, Turn } from "../../science-daemon/index.ts";
import { INTERNAL_ERROR } from "./errors.ts";
import { type FileReferences, PassingText } from "./file-references.ts";
import { type AskingWay, askUser, type WaitingMessage } from "./input-requests.ts";

/**
 * The tool calls a session has shown its client, by identifier, and whether each has ended. A
 * turn that stopped to ask is carried on by a later prompt, which hears of the turn's tool uses
 * once more: the client must not be told of a call twice.
 */
export type ShownToolCalls = Map<string, "open" | "ended">;

/** What {@link relayTurn} works with besides the turn. */
export interface RelaySurroundings {
  /** The client to pass the turn on to. */
  readonly client: AgentContext;
  /** The connection to the daemon, made on first use. */
  readonly daemon: () => Promise<ScienceDaemon>;
  /** How this client is asked what the daemon asks the user. */
  readonly askingWay: AskingWay;
}

/** The session a turn is passed on to. */
export interface RelayTarget {
  readonly sessionId: string;
  /** The tool calls the session has shown so far. {@link relayTurn} adds the turn's. */
  readonly toolCalls: ShownToolCalls;
  /** Where the conversation's files are. {@link relayTurn} adds what the turn's tools name. */
  readonly files: FileReferences;
  /**
   * The message the user sent while the turn was stopped to ask, for a turn that is taken up
   * again. It answers a request that is answered in the user's own words.
   */
  readonly message?: WaitingMessage;
}

/**
 * Passes a turn on to the client until it ends: the reply as message text, the reasoning as
 * thoughts, the tool uses as tool calls, and what the daemon asks the user as questions, whose
 * answers go back to the daemon. A file the reply names relative to a folder a tool worked in
 * is named by its full path: see {@link FileReferences}.
 *
 * A turn that asks for something the user answers in their own words ends the prompt, as
 * `end_turn`, while the turn itself stays stopped: the user's next message is the answer.
 */
export async function relayTurn(
  turn: Turn,
  { sessionId, toolCalls, files, message }: RelayTarget,
  cancel: AbortSignal,
  { client, daemon, askingWay }: RelaySurroundings,
): Promise<PromptResponse> {
  const show = (update: SessionUpdate) =>
    client.notify(methods.client.session.update, { sessionId, update });
  const say = async (text: string) => {
    if (text === "") return;
    await show({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  };
  const reply = new PassingText(files);

  // Once the client has cancelled, the turn has no more events but its end, as cancelled.
  for await (const event of turn.events) {
    if (event.type === "reply-text") {
      await say(await reply.add(event.text));
      continue;
    }
    // Text that was held back for the rest of a code span goes out before anything else does.
    await say(await reply.end());
    if (event.type === "reasoning-text") {
      await show({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.text },
      });
    } else if (event.type === "input-requested") {
      const asked = await askUser(event.requests, sessionId, client, askingWay, message);
      // The user stopped the turn while being asked: its end, as cancelled, is still to come.
      if (cancel.aborted) continue;
      // Left unanswered, the requests stay pending: the next prompt brings them up again.
      if (asked.outcome === "unanswered") return { stopReason: "cancelled" };
      if (asked.answers.length > 0) {
        const applied = await (await daemon()).answerInputRequests(
          turn.conversationId,
          asked.answers,
        );
        if (!applied) {
          await say(
            "This was already answered in Claude Science, so the answer given here " +
              "was not applied.\n\n",
          );
        }
      }
      // The turn stays stopped at the daemon. The prompt ends here so that the user can send
      // the message that answers, and the next prompt takes the turn up again.
      if (asked.outcome === "awaits-message") return { stopReason: "end_turn" };
    } else if (event.type !== "ended") {
      files.learn(event.toolUse.input);
      if (event.type === "tool-ended") files.learn(event.output);
      const update = toolCallUpdate(event, toolCalls);
      if (update !== undefined) await show(update);
    } else if (event.outcome === "failed") {
      throw new RequestError(
        INTERNAL_ERROR,
        `Claude Science could not finish the reply: ${event.detail ?? "no reason given"}`,
      );
    } else {
      return { stopReason: event.outcome === "cancelled" ? "cancelled" : "end_turn" };
    }
  }
  throw new RequestError(INTERNAL_ERROR, "The connection to Claude Science closed mid-reply.");
}

/**
 * The update that shows in the client what a turn reports about a tool use: a tool call that
 * is pending while only the tool is known, in progress once it runs, and completed or failed
 * with what the tool gave back.
 *
 * The call is titled with what the tool is doing, in Claude Science's words, and is given no
 * kind. A client may title a call of a kind it knows by its own rules: T3 Code shows "Ran
 * command" for every `execute`, which says less. Every update repeats the title, because T3
 * Code names a call "Tool" after an update that has content and no title.
 *
 * Resolves to nothing for a call that `shown` has as ended, and records the call in `shown`.
 */
function toolCallUpdate(event: ToolEvent, shown: ShownToolCalls): SessionUpdate | undefined {
  const { toolUseId: toolCallId, toolName, description, input } = event.toolUse;
  const before = shown.get(toolCallId);
  if (before === "ended") return undefined;
  shown.set(toolCallId, event.type === "tool-ended" ? "ended" : "open");
  const title = description ?? toolName;
  if (event.type === "tool-ended") {
    const { failed, output } = event;
    return {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title,
      status: failed ? "failed" : "completed",
      // Both, for the same text: T3 Code shows `rawOutput` as text and `content` as JSON.
      ...(output === ""
        ? {}
        : {
            content: [{ type: "content", content: { type: "text", text: output } }],
            rawOutput: output,
          }),
    };
  }
  const running = input === undefined ? {} : { status: "in_progress" as const, rawInput: input };
  return before === undefined
    ? { sessionUpdate: "tool_call", toolCallId, title, status: "pending", ...running }
    : { sessionUpdate: "tool_call_update", toolCallId, title, ...running };
}
