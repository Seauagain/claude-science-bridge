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
 * The message the user sent while a conversation was waiting for them. It answers one request
 * that is answered in the user's own words, and is then not sent to Claude Science as a message.
 */
export class WaitingMessage {
  readonly #text: string;
  #taken = false;

  constructor(text: string) {
    this.#text = text.trim();
  }

  /** Whether the message was taken as an answer. */
  get taken(): boolean {
    return this.#taken;
  }

  /** The message, the first time this is asked; nothing after that. */
  take(): string | undefined {
    if (this.#taken) return undefined;
    this.#taken = true;
    return this.#text;
  }
}

/** What came of asking the user: see {@link askUser}. */
export type Asked =
  /** The user answered. Requests that can only be answered in Claude Science have no answer. */
  | { readonly outcome: "answered"; readonly answers: readonly InputAnswer[] }
  /** The user left a request unanswered. Nothing is to be sent to the daemon. */
  | { readonly outcome: "unanswered" }
  /**
   * A request waits for the user's next message. `answers` are those given before it, which
   * the daemon is to have now.
   */
  | { readonly outcome: "awaits-message"; readonly answers: readonly InputAnswer[] };

/**
 * Puts what the daemon asks the user to the client, one request after the other, and collects
 * the answers.
 *
 * A request that is answered in the user's own words comes first. A client that shows forms
 * gets it as a form with a field to type in. Any other client has no way to ask for text, so
 * the request is put in the thread and the user's next message is its answer: `message` is
 * that message when it has arrived. A request that csbridge carries no answer to is only
 * described in the thread: it has to be answered in Claude Science.
 *
 * A request the user leaves unanswered, which a client also reports when its user stops the
 * turn, drops whatever was answered before it: the daemon is given a turn's choices together
 * or not at all.
 */
export async function askUser(
  requests: readonly InputRequest[],
  sessionId: string,
  client: AgentContext,
  way: AskingWay,
  message: WaitingMessage | undefined,
): Promise<Asked> {
  const say = (text: string) =>
    client.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
  const answers: InputAnswer[] = [];
  for (const request of requests) {
    if (request.typed === undefined) continue;
    if (way === "form") {
      // What the daemon wants read is longer than a form's question: it goes in the thread.
      if (request.notice !== undefined) await say(`${heading(request)}\n\n`);
      const answer = await askForText(request, sessionId, client);
      if (answer === undefined) return { outcome: "unanswered" };
      answers.push(answer);
      continue;
    }
    const text = message?.take();
    if (text === undefined) {
      await say(`${heading(request)}\n\n${instructions(request, "message")}\n\n`);
      return { outcome: "awaits-message", answers };
    }
    const answer = answerIn(request, text);
    if (answer === undefined) {
      await say(`${NOT_AN_ANSWER} ${instructions(request, "message")}\n\n`);
      return { outcome: "awaits-message", answers };
    }
    answers.push(answer);
  }
  for (const request of requests) {
    if (request.typed !== undefined) continue;
    if (request.choices.length === 0) {
      await say(
        `${request.question}. This client cannot give it: answer it in Claude Science, ` +
          "and the reply goes on here.\n\n",
      );
      continue;
    }
    const chosen =
      way === "form"
        ? await askWithForm(request, sessionId, client)
        : await askForPermission(request, sessionId, client);
    if (chosen === undefined) return { outcome: "unanswered" };
    answers.push({ request, choiceId: chosen.id });
  }
  return { outcome: "answered", answers };
}

const NOT_AN_ANSWER = "That is not what Claude Science asked for.";

/** A request that is answered in the user's own words, as the thread shows it. */
function heading(request: InputRequest): string {
  return [
    `**${request.question}**`,
    ...(request.notice === undefined ? [] : [request.notice]),
  ].join("\n\n");
}

/**
 * How to answer a request that is answered in the user's own words: in the field of a form, or
 * with the next message.
 */
function instructions(request: InputRequest, where: "form" | "message"): string {
  const what = request.typed?.what ?? "your answer";
  const others = request.choices.map(({ id, label }) => `\`${id}\` to ${label}`).join(", or ");
  if (where === "form") return `Type ${what}${others === "" ? "" : `, or ${others}`}.`;
  return `Send ${what} as your next message${others === "" ? "" : `, or send ${others}`}.`;
}

/**
 * What the user typed, as an answer to a request that is answered in the user's own words: one
 * of its choices when the text is the word for it, the text itself when the request accepts
 * it, and nothing otherwise.
 */
function answerIn(request: InputRequest, typed: string): InputAnswer | undefined {
  const text = typed.trim();
  const chosen = request.choices.find(({ id }) => id === text.toLowerCase());
  if (chosen !== undefined) return { request, choiceId: chosen.id };
  return request.typed?.accepts(text) === true ? { request, text } : undefined;
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
 * Asks for text with a form of one field to type in, until the user types an answer the request
 * takes. A form the user declines is answered with the request's way of saying no that the
 * daemon does not remember, where it has one.
 */
async function askForText(
  request: InputRequest,
  sessionId: string,
  client: AgentContext,
): Promise<InputAnswer | undefined> {
  for (let lead = ""; ; lead = `${NOT_AN_ANSWER} `) {
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
            description: `${lead}${request.question} ${instructions(request, "form")}`,
          },
        },
        required: [ANSWER],
      },
    };
    const filled = await client.request(methods.client.elicitation.create, form);
    if (filled.action === "decline") {
      const refusals = request.choices.filter((choice) => !choice.grants);
      const no = refusals.find((choice) => !choice.lasting) ?? refusals[0];
      return no === undefined ? undefined : { request, choiceId: no.id };
    }
    if (filled.action !== "accept") return undefined;
    const content = "content" in filled ? filled.content : undefined;
    const typed = isRecord(content) ? content[ANSWER] : undefined;
    if (typeof typed !== "string") return undefined;
    const answer = answerIn(request, typed);
    if (answer !== undefined) return answer;
  }
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
