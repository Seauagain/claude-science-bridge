import type { DaemonHttp } from "./http.ts";
import { expectList, expectRecord, expectString, isRecord } from "./validate.ts";

/** How hard a model is asked to think about a reply. */
export interface EffortLevel {
  readonly id: string;
  readonly name: string;
  /** Whether the daemon recommends this level for the model. */
  readonly recommended: boolean;
}

/** A model the daemon offers for conversations. */
export interface Model {
  readonly id: string;
  readonly name: string;
  /** The effort levels the model takes. Empty for a model that has no such setting. */
  readonly efforts: readonly EffortLevel[];
}

/** The models the daemon offers and what it uses when nothing is chosen. */
export interface ModelCatalog {
  readonly models: readonly Model[];
  readonly defaultModelId: string;
  /** The effort used when nothing is chosen, for models that take it. */
  readonly defaultEffort?: string;
}

/** The model and effort a message is sent with, or a conversation has. */
export interface ConversationSettings {
  readonly model?: string;
  readonly effort?: string;
}

/** Fetches the daemon's models. See `GET /models` in docs/protocol.md. */
export async function listModels(http: DaemonHttp): Promise<ModelCatalog> {
  const call = "GET /models";
  const body = expectRecord(await http.get("/models"), call);
  const providers = expectRecord(body.models, call);
  const models = Object.values(providers).flatMap((offered) =>
    expectList(offered, call).map((entry) => {
      const model = expectRecord(entry, call);
      return {
        id: expectString(model, "id", call),
        name: expectString(model, "name", call),
        efforts: effortsOf(model.effort, call),
      };
    }),
  );
  const defaultEffort = body.default_effort;
  return {
    models,
    defaultModelId: expectString(body, "default_model_id", call),
    ...(typeof defaultEffort === "string" && defaultEffort !== "" ? { defaultEffort } : {}),
  };
}

/** Reads a model's effort levels: none when the model is marked as not supporting effort. */
function effortsOf(effort: unknown, call: string): EffortLevel[] {
  if (!isRecord(effort) || effort.supported !== true) return [];
  return expectList(effort.options, call).map((entry) => {
    const option = expectRecord(entry, call);
    return {
      id: expectString(option, "id", call),
      name: expectString(option, "name", call),
      recommended: option.recommended === true,
    };
  });
}

/** Reads the model and effort a conversation has. Either is absent when the daemon has none. */
export async function readConversationSettings(
  http: DaemonHttp,
  conversationId: string,
): Promise<ConversationSettings> {
  const call = "GET /frames/<id>";
  const frame = expectRecord(
    await http.get(`/frames/${encodeURIComponent(conversationId)}?shallow=true`),
    call,
  );
  const { model, effort } = frame;
  return {
    ...(typeof model === "string" && model !== "" ? { model } : {}),
    ...(typeof effort === "string" && effort !== "" ? { effort } : {}),
  };
}
