import type { DaemonHttp } from "./http.ts";
import { isRecord, type JsonRecord } from "./validate.ts";

/** One answer the user can give to an {@link InputRequest}. */
export interface InputChoice {
  /** Tells the choice apart from the request's other choices. */
  readonly id: string;
  /** What the choice is called, short enough for a button. */
  readonly label: string;
  /** Whether the choice gives the daemon what it asked for. */
  readonly grants: boolean;
  /** Whether the daemon remembers the choice beyond this one request. */
  readonly lasting: boolean;
}

/**
 * What a request takes in the user's own words, such as an email address. A request that has
 * this is answered with such text or with one of its choices.
 */
export interface TypedAnswer {
  /** What to type, as it follows "send": `the address`, for example. */
  readonly what: string;
  /** Whether `text` is such an answer. An email address has to look like one. */
  accepts(text: string): boolean;
}

/**
 * Something the daemon asks the user before a turn can go on: an approval, for example of
 * access to a folder, a question with choices, or something to type.
 */
export interface InputRequest {
  readonly requestId: string;
  /** The daemon's name for what is asked, for example `host` or `ask`. */
  readonly kind: string;
  /** What is asked, as one line for the user. */
  readonly question: string;
  /** What the daemon wants the user to have read before answering, in its own words. */
  readonly notice?: string;
  /**
   * The answers the user can pick. With {@link InputRequest.typed} these are the other answers
   * the request takes, such as declining, and each `id` is a word the user can say it with.
   * Without it, an empty list means a request that can only be answered in Claude Science
   * itself, such as one for a password.
   */
  readonly choices: readonly InputChoice[];
  /** Present for a request that is answered in the user's own words. */
  readonly typed?: TypedAnswer;
}

/** The answer the user gave to one input request: one of its choices, or text they typed. */
export type InputAnswer =
  | {
      readonly request: InputRequest;
      /** The `id` of one of the request's choices. */
      readonly choiceId: string;
    }
  | {
      readonly request: InputRequest;
      /** Text the request's {@link TypedAnswer} accepts. */
      readonly text: string;
    };

/** What answering a request takes besides the user's choice. */
interface Wire {
  /** The frame that asked, which is where the answer goes. */
  readonly frameId: string | undefined;
  readonly toolId: string | undefined;
  /** What each choice is as a response, less the fields every response has. */
  readonly responses: ReadonlyMap<string, JsonRecord>;
  /** What text the user typed is as a response, for a request that takes it. */
  readonly typedResponse: ((text: string) => JsonRecord) | undefined;
}

/** Kept beside the requests, so that what the daemon needs back stays out of their interface. */
const wires = new WeakMap<InputRequest, Wire>();

/**
 * Reads the input requests of a `pending_input_requests` list, as a `frame_update` event or a
 * frame's `output_data` carries it. See "Input requests" in docs/protocol.md. Entries that are
 * no requests are left out. `holder` is the frame the list belongs to, which is where the
 * answers go.
 */
export function parseInputRequests(value: unknown, holder: string | undefined): InputRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.requestId !== "string") return [];
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    const { question, notice, choices, typed } = describe(kind, entry);
    const request: InputRequest = {
      requestId: entry.requestId,
      kind,
      question,
      ...(notice === undefined ? {} : { notice }),
      choices: choices.map(({ response: _response, ...choice }) => choice),
      ...(typed === undefined ? {} : { typed: { what: typed.what, accepts: typed.accepts } }),
    };
    wires.set(request, {
      frameId: holder ?? (typeof entry.frameId === "string" ? entry.frameId : undefined),
      toolId: typeof entry.tool_id === "string" ? entry.tool_id : undefined,
      responses: new Map(choices.map(({ id, response }) => [id, response])),
      typedResponse: typed?.response,
    });
    return [request];
  });
}

/**
 * Sends the user's answers to the daemon: `POST /frames/<id>/resolve-input`. A turn that
 * stopped to ask carries on by itself once its requests are answered.
 *
 * Resolves to false when the daemon says the requests had their answers already, from the
 * browser for example, so that these answers changed nothing.
 *
 * @throws Error for an answer whose request did not come from {@link parseInputRequests}, whose
 *   choice the request does not have or whose text it does not accept: all are mistakes of the
 *   caller.
 */
export async function answerInputRequests(
  http: DaemonHttp,
  conversationId: string,
  answers: readonly InputAnswer[],
): Promise<boolean> {
  const byFrame = new Map<string, JsonRecord[]>();
  for (const answer of answers) {
    const { request } = answer;
    const wire = wires.get(request);
    const response = wire === undefined ? undefined : responseOf(answer, wire);
    if (wire === undefined || response === undefined) {
      throw new Error(
        `Input request ${request.requestId} does not take ${
          "text" in answer ? "this text" : `the choice "${answer.choiceId}"`
        }.`,
      );
    }
    const frameId = wire.frameId ?? conversationId;
    byFrame.set(frameId, [
      ...(byFrame.get(frameId) ?? []),
      {
        requestId: request.requestId,
        ...(wire.toolId === undefined ? {} : { tool_id: wire.toolId }),
        ...response,
      },
    ]);
  }
  let applied = true;
  for (const [frameId, responses] of byFrame) {
    const answer = await http.post(`/frames/${encodeURIComponent(frameId)}/resolve-input`, {
      responses,
    });
    if (isRecord(answer) && answer.status === "already_resolved") applied = false;
  }
  return applied;
}

function responseOf(answer: InputAnswer, wire: Wire): JsonRecord | undefined {
  if (!("text" in answer)) return wire.responses.get(answer.choiceId);
  const text = answer.text.trim();
  return answer.request.typed?.accepts(text) === true ? wire.typedResponse?.(text) : undefined;
}

type Choice = InputChoice & { readonly response: JsonRecord };

/** A request as csbridge puts it to the user, with what each answer is on the wire. */
interface Described {
  readonly question: string;
  readonly notice?: string;
  readonly choices: readonly Choice[];
  readonly typed?: TypedAnswer & { readonly response: (text: string) => JsonRecord };
}

const DENY: Choice = {
  id: "deny",
  label: "Deny",
  grants: false,
  lasting: false,
  response: { approved: false, action: "deny" },
};

/** How long the daemon remembers an approval. */
type Scope = "once" | "conversation" | "project" | "always";

const ALLOW_LABEL: Readonly<Record<Scope, string>> = {
  once: "Allow once",
  conversation: "Allow for this conversation",
  project: "Allow for this project",
  always: "Always allow",
};

const EVERY_SCOPE: readonly Scope[] = ["once", "conversation", "project", "always"];

/**
 * The approvals that take nothing but yes or no, with the scopes the daemon's own client
 * offers for each and the one it suggests, and the question each one is.
 */
const APPROVALS: Readonly<
  Record<
    string,
    {
      readonly scopes: readonly Scope[];
      readonly suggested: Scope;
      readonly question: (request: JsonRecord) => string;
    }
  >
> = {
  network: {
    scopes: [],
    suggested: "always",
    question: (r) => `Allow network access${named(" to ", r.target)}?`,
  },
  host_delete: {
    scopes: ["once", "conversation"],
    suggested: "once",
    question: (r) => `Delete files on your computer${listed(": ", r.paths)}?`,
  },
  artifact_delete: {
    scopes: ["once", "conversation"],
    suggested: "once",
    question: () => "Delete artifacts of this project?",
  },
  mcp_tool: {
    scopes: EVERY_SCOPE,
    suggested: "project",
    question: (r) =>
      `Use the connector tool ${text(r.server_name) ?? "of a connector"}${named(": ", r.tool_name)}?`,
  },
  customize_mutation: {
    scopes: EVERY_SCOPE,
    suggested: "project",
    question: (r) => `Change your Claude Science setup${named(": ", r.label)}?`,
  },
  local_exec: {
    scopes: EVERY_SCOPE,
    suggested: "conversation",
    question: (r) => `Run code on your computer${named(" with ", r.tool)}?`,
  },
  remote_exec: {
    scopes: EVERY_SCOPE,
    suggested: "once",
    question: (r) =>
      `Run a command on ${text(r.provider) ?? "a remote machine"}${named(": ", r.command)}?`,
  },
  remote_read: {
    scopes: EVERY_SCOPE,
    suggested: "conversation",
    question: (r) =>
      `Read ${text(r.remote_path) ?? "files"} on ${text(r.provider) ?? "a remote machine"}?`,
  },
  credential_access: {
    scopes: EVERY_SCOPE,
    suggested: "conversation",
    question: (r) => `Let the agent read the stored credential${named(" ", r.name)}?`,
  },
  byoc_submit: {
    scopes: EVERY_SCOPE,
    suggested: "once",
    question: (r) => `Submit a job to ${text(r.provider) ?? "your cloud compute"}?`,
  },
  byoc_kernel: {
    scopes: EVERY_SCOPE,
    suggested: "conversation",
    question: (r) => `Give the agent a shell on ${text(r.provider) ?? "your cloud compute"}?`,
  },
  infer_submit: {
    scopes: EVERY_SCOPE,
    suggested: "once",
    question: (r) => `Call the model endpoint${named(" ", r.endpoint ?? r.provider)}?`,
  },
  managed_endpoint_register: {
    scopes: [],
    suggested: "once",
    question: (r) => `Register the model endpoint${named(" ", r.name ?? r.url)}?`,
  },
  set_goal: {
    scopes: [],
    suggested: "once",
    question: () => "Let the agent work towards a goal on its own?",
  },
  usage_checkpoint: {
    scopes: [],
    suggested: "once",
    question: () => "Keep going past the usage checkpoint?",
  },
  skill_license: {
    scopes: ["project", "always"],
    suggested: "always",
    question: (r) =>
      `Confirm that you are licensed for the restricted resource of the skill${named(" ", r.skill_name)}?`,
  },
};

/**
 * What the daemon waits for with the kinds csbridge carries no answer to. The first two are
 * secrets, which do not belong in the text of a thread.
 */
const LEFT_TO_CLAUDE_SCIENCE: Readonly<Record<string, string>> = {
  credential_request: "a credential",
  ssh_password: "an SSH password",
  provider_discovery: "an answer about your compute",
};

function describe(kind: string, request: JsonRecord): Described {
  if (kind === "host") return folderAccess(request);
  if (kind === "ask") return questionWithChoices(request) ?? questionInWords(request);
  if (kind === "contact_email") return contactEmail(request);
  const approval = APPROVALS[kind];
  if (approval === undefined) {
    const awaited = LEFT_TO_CLAUDE_SCIENCE[kind] ?? `an answer ("${kind}")`;
    return { question: `Claude Science is waiting for ${awaited}`, choices: [] };
  }
  const reason = text(request.reason);
  return {
    question: approval.question(request) + (reason === undefined ? "" : ` Reason: ${reason}`),
    choices: [...allowChoices(approval.scopes, approval.suggested), DENY],
  };
}

/** Access to a folder on the user's computer, which the daemon remembers once it is given. */
function folderAccess(request: JsonRecord): Described {
  const writes = request.requested_mode === "rw";
  const allow = (mode: "ro" | "rw", label: string): Choice => ({
    id: `allow:${mode}`,
    label,
    grants: true,
    lasting: true,
    response: { approved: true, action: "allow", mode, scope: "always" },
  });
  const target = text(request.target);
  const wanted = text(request.requested_path);
  const granted =
    request.existing_mode === "rw"
      ? "read and write"
      : request.existing_mode === "ro"
        ? "read-only"
        : undefined;
  return {
    question:
      `Access ${target ?? "a folder"} on your computer (${
        writes ? "read and write" : "read-only"
      })?` +
      (wanted === undefined || wanted === target ? "" : ` It is asked for ${wanted}.`) +
      (granted === undefined ? "" : ` The folder has ${granted} access now.`),
    choices: [
      ...(writes ? [allow("rw", "Allow read & write")] : []),
      allow("ro", "Allow read-only"),
      DENY,
    ],
  };
}

const SKIP_QUESTION: Choice = {
  id: "skip",
  label: "Skip",
  grants: false,
  lasting: false,
  response: { approved: false, action: "cancel" },
};

/** The first question of an `ask` request and the labels of its options. */
function firstQuestion(request: JsonRecord): { question: string | undefined; labels: string[] } {
  const [asked] = Array.isArray(request.questions) ? request.questions : [];
  if (!isRecord(asked)) return { question: undefined, labels: [] };
  return {
    question: text(asked.question),
    labels: (Array.isArray(asked.options) ? asked.options : []).flatMap((option) =>
      isRecord(option) && typeof option.label === "string" ? [option.label] : [],
    ),
  };
}

/**
 * A single question with choices to pick one from. The daemon can also ask several questions
 * at once and let several choices be picked: those are {@link questionInWords}.
 */
function questionWithChoices(request: JsonRecord): Described | undefined {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const [asked] = questions;
  if (questions.length !== 1 || !isRecord(asked) || asked.multi_select === true) return undefined;
  const { question, labels } = firstQuestion(request);
  if (question === undefined || labels.length === 0) return undefined;
  return {
    question,
    choices: [
      ...labels.map(
        (label, index): Choice => ({
          id: `answer:${index}`,
          label,
          grants: true,
          lasting: false,
          response: { approved: true, action: "answer", answers: { [question]: label } },
        }),
      ),
      SKIP_QUESTION,
    ],
  };
}

/**
 * A question that takes more than one pick: it is answered in the user's own words, which the
 * daemon takes as it takes text typed into its own client. Of several questions the first is
 * put, as that client does.
 */
function questionInWords(request: JsonRecord): Described {
  const { question, labels } = firstQuestion(request);
  if (question === undefined) {
    return { question: "Claude Science is waiting for an answer to its questions", choices: [] };
  }
  return {
    question,
    ...(labels.length === 0
      ? {}
      : {
          notice: [
            "Name one or more of these, separated by commas, or answer in your own words:",
            ...labels.map((label) => `- ${label}`),
          ].join("\n"),
        }),
    choices: [{ ...SKIP_QUESTION, label: "skip the question" }],
    typed: {
      what: "your answer",
      accepts: (answer) => answer !== "",
      response: (answer) => ({ approved: true, action: "answer", answers: { [question]: answer } }),
    },
  };
}

/**
 * A contact email address for the research services that ask for one. The daemon's notice says
 * what the address is used for, and the daemon records the notice with the user's decision.
 */
function contactEmail(request: JsonRecord): Described {
  const notice = typeof request.notice_text === "string" ? request.notice_text.trim() : "";
  return {
    question: "Claude Science asks for a contact email address.",
    ...(notice === "" ? {} : { notice }),
    choices: [
      {
        id: "decline",
        label: "share none and not be asked again",
        grants: false,
        lasting: true,
        response: { approved: false, action: "deny" },
      },
      {
        id: "skip",
        label: "decide later",
        grants: false,
        lasting: false,
        response: { approved: false, action: "cancel" },
      },
    ],
    typed: {
      what: "the address",
      accepts: isEmailAddress,
      response: (address) => ({ approved: true, action: "allow", text: address }),
    },
  };
}

/** What the daemon takes for an email address. */
function isEmailAddress(value: string): boolean {
  if (value.length > 320) return false;
  // No control characters, which `\s` covers only in part.
  if ([...value].some((character) => character < " " || character === "\u007f")) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * The ways to allow: once where the daemon offers that, and the scope its own client suggests
 * or, where that is once as well, the next one up. A kind without scopes is simply allowed.
 */
function allowChoices(scopes: readonly Scope[], suggested: Scope): Choice[] {
  const allow = (scope: Scope, id: string, label: string): Choice => ({
    id,
    label,
    grants: true,
    lasting: scope !== "once",
    // The daemon takes "once" as the absence of a scope.
    response: { approved: true, action: "allow", ...(scope === "once" ? {} : { scope }) },
  });
  if (scopes.length === 0) return [allow(suggested, "allow", "Allow")];
  const lasting = suggested !== "once" ? suggested : scopes.find((scope) => scope !== "once");
  return [
    ...(scopes.includes("once") ? [allow("once", "allow:once", ALLOW_LABEL.once)] : []),
    ...(lasting === undefined ? [] : [allow(lasting, `allow:${lasting}`, ALLOW_LABEL[lasting])]),
  ];
}

/** A non-empty string, cut to a length that fits one line. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const line = value.trim().replaceAll(/\s+/g, " ");
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

function named(lead: string, value: unknown): string {
  const name = text(value);
  return name === undefined ? "" : lead + name;
}

function listed(lead: string, value: unknown): string {
  const items = (Array.isArray(value) ? value : []).flatMap((item) => text(item) ?? []);
  if (items.length === 0) return "";
  return lead + items.slice(0, 3).join(", ") + (items.length > 3 ? ", …" : "");
}
