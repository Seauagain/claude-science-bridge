import { isRecord } from "../validate.ts";

/** What decides how a further message to a conversation is answered. */
export interface MessageTarget {
  readonly id: string;
  readonly agentName: string;
  readonly status: string;
}

/** A `POST /request` the fake daemon accepts, or the error it answers with. */
export type FurtherMessage<Target> =
  | {
      readonly conversation: Target;
      readonly text: string;
      readonly intentId: string;
      /** The `status` of the response. See the notes on `POST /request` in docs/protocol.md. */
      readonly responseStatus: "accepted" | "message_queued";
    }
  | { readonly refusal: { readonly httpStatus: number; readonly detail: string } };

/**
 * Reads the body of `POST /request` as docs/protocol.md describes it.
 *
 * Requests the notes do not cover are refused instead of answered with invented behaviour, so
 * that code relying on something nobody observed fails its tests.
 */
export function readFurtherMessage<Target extends MessageTarget>(
  body: unknown,
  conversations: readonly Target[],
  usedIntentIds: ReadonlySet<string>,
): FurtherMessage<Target> {
  const fields = isRecord(body) ? body : {};
  if (typeof fields.target_agent !== "string") {
    return refusal(400, "Invalid arguments: body.target_agent: Required");
  }
  const conversation = conversations.find((candidate) => candidate.id === fields.root_frame_id);
  if (conversation === undefined) {
    return refusal(404, `Frame ${String(fields.root_frame_id)} not found`);
  }

  const text = isRecord(fields.input_data) ? fields.input_data.request : undefined;
  const intentId = fields.intent_id;
  const problem =
    (fields.target_agent !== conversation.agentName &&
      "target_agent is not the conversation frame's agent_name") ||
    (fields.frame_id !== conversation.id && "frame_id is not the conversation's frame") ||
    (fields.plan_mode !== false && "plan_mode is not false") ||
    (conversation.status === "processing" && "the conversation's turn is still running");
  if (problem !== false) return undocumented(problem);
  if (typeof text !== "string") return undocumented("input_data.request is not a string");
  if (typeof intentId !== "string" || intentId === "" || usedIntentIds.has(intentId)) {
    return undocumented("intent_id is not a fresh identifier");
  }

  return {
    conversation,
    text,
    intentId,
    responseStatus: conversation.status === "cancelled" ? "message_queued" : "accepted",
  };
}

function refusal(httpStatus: number, detail: string): FurtherMessage<never> {
  return { refusal: { httpStatus, detail } };
}

function undocumented(problem: string): FurtherMessage<never> {
  return refusal(
    400,
    `fake daemon: ${problem}; docs/protocol.md does not say how the daemon answers that`,
  );
}
