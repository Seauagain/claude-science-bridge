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
 * Something the daemon asks the user before a turn can go on: an approval, for example of
 * access to a folder, or a question with choices.
 */
export interface InputRequest {
  readonly requestId: string;
  /** The daemon's name for what is asked, for example `host` or `ask`. */
  readonly kind: string;
  /** What is asked, as one line for the user. */
  readonly question: string;
  /**
   * The answers the user can give. Empty for a request that takes more than a choice, such as
   * a password: that one can only be answered in Claude Science itself.
   */
  readonly choices: readonly InputChoice[];
}

/** The choice the user made for one input request. */
export interface InputAnswer {
  readonly request: InputRequest;
  /** The `id` of one of the request's choices. */
  readonly choiceId: string;
}

/** What answering a request takes besides the user's choice. */
interface Wire {
  /** The frame that asked, which is where the answer goes. */
  readonly frameId: string | undefined;
  readonly toolId: string | undefined;
  /** What each choice is as a response, less the fields every response has. */
  readonly responses: ReadonlyMap<string, JsonRecord>;
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
    const { question, choices } = describe(kind, entry);
    const request: InputRequest = {
      requestId: entry.requestId,
      kind,
      question,
      choices: choices.map(({ response: _response, ...choice }) => choice),
    };
    wires.set(request, {
      frameId: holder ?? (typeof entry.frameId === "string" ? entry.frameId : undefined),
      toolId: typeof entry.tool_id === "string" ? entry.tool_id : undefined,
      responses: new Map(choices.map(({ id, response }) => [id, response])),
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
 * @throws Error for an answer whose request did not come from {@link parseInputRequests} or
 *   whose choice the request does not have: both are mistakes of the caller.
 */
export async function answerInputRequests(
  http: DaemonHttp,
  conversationId: string,
  answers: readonly InputAnswer[],
): Promise<boolean> {
  const byFrame = new Map<string, JsonRecord[]>();
  for (const { request, choiceId } of answers) {
    const wire = wires.get(request);
    const response = wire?.responses.get(choiceId);
    if (wire === undefined || response === undefined) {
      throw new Error(`Input request ${request.requestId} has no choice "${choiceId}".`);
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

type Choice = InputChoice & { readonly response: JsonRecord };

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

/** What the daemon waits for with the kinds that take more than a choice. */
const TYPED_ANSWERS: Readonly<Record<string, string>> = {
  ask: "an answer to its questions",
  credential_request: "a credential",
  ssh_password: "an SSH password",
  provider_discovery: "an answer about your compute",
  contact_email: "a contact email address",
};

function describe(
  kind: string,
  request: JsonRecord,
): { question: string; choices: readonly Choice[] } {
  if (kind === "host") return folderAccess(request);
  if (kind === "ask") {
    const asked = questionWithChoices(request);
    if (asked !== undefined) return asked;
  }
  const approval = APPROVALS[kind];
  if (approval === undefined) {
    const awaited = TYPED_ANSWERS[kind] ?? `an answer ("${kind}")`;
    return { question: `Claude Science is waiting for ${awaited}`, choices: [] };
  }
  const reason = text(request.reason);
  return {
    question: approval.question(request) + (reason === undefined ? "" : ` Reason: ${reason}`),
    choices: [...allowChoices(approval.scopes, approval.suggested), DENY],
  };
}

/** Access to a folder on the user's computer, which the daemon remembers once it is given. */
function folderAccess(request: JsonRecord): { question: string; choices: readonly Choice[] } {
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

/**
 * A single question with choices to pick one from. The daemon can also ask several questions
 * at once, let several choices be picked and take free text: those have no choices here.
 */
function questionWithChoices(
  request: JsonRecord,
): { question: string; choices: readonly Choice[] } | undefined {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const [asked] = questions;
  if (questions.length !== 1 || !isRecord(asked) || asked.multi_select === true) return undefined;
  const question = text(asked.question);
  const labels = (Array.isArray(asked.options) ? asked.options : []).flatMap((option) =>
    isRecord(option) && typeof option.label === "string" ? [option.label] : [],
  );
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
      {
        id: "skip",
        label: "Skip",
        grants: false,
        lasting: false,
        response: { approved: false, action: "cancel" },
      },
    ],
  };
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
