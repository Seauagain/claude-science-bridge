import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ConversationSettings, Model, ModelCatalog } from "../../science-daemon/index.ts";
import { INVALID_PARAMS } from "./errors.ts";

/** The identifiers of the options a session offers its client. */
const MODEL_OPTION = "model";
const EFFORT_OPTION = "effort";

/**
 * What decides a session's model and effort: what its user chose, or what its conversation
 * has. Whatever is absent follows the daemon's defaults.
 */
export interface SessionSettings {
  model?: string;
  effort?: string;
  /** Set once the session has a conversation. From then on the daemon keeps the effort. */
  conversationId?: string;
}

/**
 * The model and effort in force for a session: the chosen ones where the daemon offers them,
 * otherwise its defaults. An effort the model does not take gives way to the one the daemon
 * recommends for that model.
 */
export function settingsInForce(
  catalog: ModelCatalog,
  session: SessionSettings,
): ConversationSettings {
  const model = modelInForce(catalog, session);
  if (model === undefined) return {};
  const takes = (effort: string | undefined) => model.efforts.some(({ id }) => id === effort);
  const effort =
    (takes(session.effort) ? session.effort : undefined) ??
    model.efforts.find(({ recommended }) => recommended)?.id ??
    (takes(catalog.defaultEffort) ? catalog.defaultEffort : undefined) ??
    model.efforts[0]?.id;
  return { model: model.id, ...(effort === undefined ? {} : { effort }) };
}

/**
 * The options a client shows for a session: the model, and the effort when the model in force
 * takes one. Clients read the category to tell which is which.
 */
export function settingsOptions(
  catalog: ModelCatalog,
  session: SessionSettings,
): SessionConfigOption[] {
  const model = modelInForce(catalog, session);
  if (model === undefined) return [];
  const { effort } = settingsInForce(catalog, session);
  const options: SessionConfigOption[] = [
    {
      id: MODEL_OPTION,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model.id,
      options: catalog.models.map(({ id, name }) => ({ value: id, name })),
    },
  ];
  if (effort !== undefined) {
    options.push({
      id: EFFORT_OPTION,
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: model.efforts.map(({ id, name }) => ({ value: id, name })),
    });
  }
  return options;
}

/**
 * Takes a choice the client made for one of the session's options.
 *
 * A model can be changed at any time. An effort is taken only before the session has a
 * conversation: the daemon keeps the effort a conversation started with, so a later choice is
 * left aside, and the options sent back show what still holds.
 *
 * @throws RequestError (invalid params) for an option or a value the session does not offer.
 */
export function chooseSetting(
  catalog: ModelCatalog,
  session: SessionSettings,
  optionId: string,
  value: unknown,
): void {
  if (optionId === MODEL_OPTION) {
    const offered = catalog.models.map(({ id }) => id);
    if (typeof value !== "string" || !offered.includes(value)) {
      throw refused(`Claude Science has no model "${String(value)}"`, offered);
    }
    session.model = value;
    return;
  }
  if (optionId === EFFORT_OPTION) {
    const offered = (modelInForce(catalog, session)?.efforts ?? []).map(({ id }) => id);
    if (typeof value !== "string" || !offered.includes(value)) {
      throw refused(`The model in use does not take the effort "${String(value)}"`, offered);
    }
    if (session.conversationId === undefined) session.effort = value;
    return;
  }
  throw new RequestError(INVALID_PARAMS, `This session has no option "${optionId}".`);
}

function modelInForce(catalog: ModelCatalog, session: SessionSettings): Model | undefined {
  const named = (wanted: string | undefined) => catalog.models.find(({ id }) => id === wanted);
  return named(session.model) ?? named(catalog.defaultModelId) ?? catalog.models[0];
}

function refused(problem: string, offered: readonly string[]): RequestError {
  return new RequestError(INVALID_PARAMS, `${problem}. It offers: ${offered.join(", ")}.`);
}
