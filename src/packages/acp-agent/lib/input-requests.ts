import {
  type AgentContext,
  type ClientCapabilities,
  type CreateElicitationRequest,
  methods,
  type PermissionOptionKind,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type { InputAnswer, InputChoice, InputRequest } from "../../science-daemon/index.ts";

/**
 * How a client is asked what the daemon asks the user.
 *
 * `form`: with a form (ACP elicitation) that offers the request's own choices. This is for a
 * client that says it can show forms. `permission`: with an ACP permission request, which
 * every client takes.
 *
 * The form comes first because a client decides permission requests by rules of its own and
 * may answer them without showing them. T3 Code allows every one in its Auto and Full access
 * modes, and has three fixed buttons for the rest, whatever the choices are. What Claude
 * Science asks is the user's to answer: access to a folder on their computer, for example.
 */
export type AskingWay = "form" | "permission";

/** The way to ask a client that initialized with these capabilities. */
export function askingWayOf(capabilities: ClientCapabilities | undefined): AskingWay {
  return capabilities?.elicitation?.form == null ? "permission" : "form";
}

/**
 * Puts what the daemon asks the user to the client, one request after the other, and collects
 * the answers.
 *
 * A request that takes more than a choice is only described in the thread: it has to be
 * answered in Claude Science, and gets no answer here.
 *
 * Resolves to nothing when the user left a request unanswered, which a client also reports
 * when its user stops the turn. Whatever was answered before that is dropped with it: the
 * daemon is given all of a turn's answers together or none.
 */
export async function askUser(
  requests: readonly InputRequest[],
  sessionId: string,
  client: AgentContext,
  way: AskingWay,
): Promise<InputAnswer[] | undefined> {
  const answers: InputAnswer[] = [];
  for (const request of requests) {
    if (request.choices.length === 0) {
      await client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              `${request.question}. This client cannot give it: answer it in Claude Science, ` +
              "and the reply goes on here.\n\n",
          },
        },
      });
      continue;
    }
    const chosen =
      way === "form"
        ? await askWithForm(request, sessionId, client)
        : await askForPermission(request, sessionId, client);
    if (chosen === undefined) return undefined;
    answers.push({ request, choiceId: chosen.id });
  }
  return answers;
}

/** The name of a form's only field. */
const ANSWER = "answer";

/**
 * Asks with a form of one field, whose choices are the request's. A form the user declines is
 * answered with the request's way of saying no.
 */
async function askWithForm(
  request: InputRequest,
  sessionId: string,
  client: AgentContext,
): Promise<InputChoice | undefined> {
  const form: CreateElicitationRequest = {
    mode: "form",
    sessionId,
    message: request.question,
    requestedSchema: {
      type: "object",
      properties: {
        [ANSWER]: {
          type: "string",
          title: "Claude Science asks",
          description: request.question,
          oneOf: request.choices.map((choice) => ({ const: choice.id, title: choice.label })),
        },
      },
      required: [ANSWER],
    },
  };
  const filled = await client.request(methods.client.elicitation.create, form);
  if (filled.action === "decline") return request.choices.find((choice) => !choice.grants);
  if (filled.action !== "accept") return undefined;
  const content = "content" in filled ? filled.content : undefined;
  const picked = isRecord(content) ? content[ANSWER] : undefined;
  return request.choices.find(({ id }) => id === picked);
}

/**
 * Asks with a permission request. The request shows in the thread as a tool call, which ends
 * as completed when the user gave the daemon what it asked for and as failed otherwise.
 */
async function askForPermission(
  request: InputRequest,
  sessionId: string,
  client: AgentContext,
): Promise<InputChoice | undefined> {
  const toolCallId = `input-request:${request.requestId}`;
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: request.question,
      kind: "other",
      status: "pending",
    },
  });
  const asked: RequestPermissionRequest = {
    sessionId,
    toolCall: { toolCallId, title: request.question, kind: "other", status: "pending" },
    options: request.choices.map((choice) => ({
      optionId: choice.id,
      name: choice.label,
      kind: optionKind(choice),
    })),
  };
  const { outcome } = await client.request(methods.client.session.requestPermission, asked);
  const chosen =
    outcome.outcome === "selected"
      ? request.choices.find(({ id }) => id === outcome.optionId)
      : undefined;
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: chosen?.grants === true ? "completed" : "failed",
    },
  });
  return chosen;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** ACP's hint to the client about what kind of answer an option is. */
function optionKind(choice: InputChoice): PermissionOptionKind {
  if (!choice.grants) return "reject_once";
  return choice.lasting ? "allow_always" : "allow_once";
}
