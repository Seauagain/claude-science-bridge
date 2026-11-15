import { addedByDaemon } from "./message-origin.ts";
import { isRecord, type JsonRecord } from "./validate.ts";

/** One use of a tool by Claude Science. */
export interface ToolUse {
  /** The daemon's identifier for this use of the tool, unique in the conversation. */
  readonly toolUseId: string;
  /** The tool's programmatic name. */
  readonly toolName: string;
  /** What the tool is doing, in words meant for the user, when the daemon recorded that. */
  readonly description?: string;
  /**
   * What the tool was given to work on: its arguments by name. Absent until the daemon has
   * recorded them, which it does only once the tool runs.
   */
  readonly input?: Readonly<Record<string, unknown>>;
}

/** How a use of a tool ended. */
export interface ToolResult {
  readonly toolUseId: string;
  /** Whether the tool reported that it could not do what it was asked. */
  readonly failed: boolean;
  /** What the tool gave back, as text to read. Empty when it gave nothing. */
  readonly output: string;
}

/** What messages hold about tool uses, in the messages' order: each use and each result. */
export type ToolActivity = readonly (
  | { readonly use: ToolUse; readonly result?: never }
  | { readonly result: ToolResult; readonly use?: never }
)[];

/** What a turn reports about a tool use. See {@link ToolLedger}. */
export type ToolEvent =
  /**
   * Claude Science began to use a tool. Reported once for each use, with what is known by
   * then: the tool's name always, its description and input often not yet.
   */
  | { readonly type: "tool-started"; readonly toolUse: ToolUse }
  /**
   * The description and input of a tool use that started without them. Reported at most once
   * for each use, when the tool runs.
   */
  | { readonly type: "tool-detailed"; readonly toolUse: ToolUse }
  /**
   * A tool use ended. Reported once for each use that was reported as started, at the latest
   * when the turn ends: a use that is open then did not finish, and is reported as failed
   * unless the turn completed. Only a turn that ends to wait for the user leaves uses open.
   */
  | {
      readonly type: "tool-ended";
      readonly toolUse: ToolUse;
      readonly failed: boolean;
      readonly output: string;
    };

/**
 * The tool activity of the turn that transcript messages belong to: of the messages after the
 * last one the user sent, or of all of them when the user sent none. The messages are as the
 * daemon serves or pushes them; what does not look like a message or a tool block is skipped.
 * See "Tool activity" in docs/protocol.md.
 */
export function turnToolActivity(messages: readonly unknown[]): ToolActivity {
  return messages
    .slice(messages.findLastIndex(isUsersOwn) + 1)
    .flatMap((message) =>
      isRecord(message) && Array.isArray(message.content) ? message.content : [],
    )
    .filter(isRecord)
    .flatMap((block): ToolActivity[number][] => {
      const use = toolUseOf(block);
      if (use !== undefined) return [{ use }];
      const result = toolResultOf(block);
      return result === undefined ? [] : [{ result }];
    });
}

/** Reads a block as a tool use. Resolves to nothing for any other block. */
export function toolUseOf(block: JsonRecord): ToolUse | undefined {
  if (block.type !== "tool_use" && block.type !== "server_tool_use") return undefined;
  const { id, name } = block;
  if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") {
    return undefined;
  }
  const { human_description: description, ...input } = isRecord(block.input) ? block.input : {};
  return {
    toolUseId: id,
    toolName: name,
    ...(typeof description === "string" && description !== "" ? { description } : {}),
    input,
  };
}

/** Whether the user sent a message: the daemon files tool results and its own messages as theirs. */
function isUsersOwn(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "user" || addedByDaemon(message)) return false;
  const { content } = message;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  const blocks = content.filter(isRecord);
  return (
    blocks.some((block) => block.type === "text" && block._harness_notice !== true) &&
    !blocks.some((block) => block.type === "tool_result")
  );
}

/** A tool's own result block, or a server tool's, which is named after the tool. */
function toolResultOf(block: JsonRecord): ToolResult | undefined {
  const { type, tool_use_id: toolUseId } = block;
  if (typeof type !== "string" || !type.endsWith("tool_result")) return undefined;
  if (typeof toolUseId !== "string" || toolUseId === "") return undefined;
  const { failed, output } = readContent(block.content);
  return { toolUseId, failed: failed || block.is_error === true, output };
}

/**
 * Reads what a tool gave back and whether that amounts to a failure, by the rules of the
 * daemon's web client. A code tool's output is what it printed, not the JSON that wraps it.
 */
function readContent(content: unknown): { failed: boolean; output: string } {
  if (typeof content === "string") {
    const report = parsedRecord(content);
    return report === undefined ? { failed: false, output: content } : readReport(report, content);
  }
  if (Array.isArray(content)) {
    return { failed: false, output: content.filter(isRecord).map(lineOf).join("\n") };
  }
  if (isRecord(content) && typeof content.type === "string" && content.type.endsWith("_error")) {
    const reason = typeof content.error_code === "string" ? content.error_code : content.type;
    return { failed: true, output: reason };
  }
  return { failed: false, output: "" };
}

/** Reads a result that is a JSON object. `text` is that JSON as the daemon sent it. */
function readReport(report: JsonRecord, text: string): { failed: boolean; output: string } {
  const { stdout, stderr, exit_code: exitCode, error } = report;
  if (typeof stdout === "string" || typeof stderr === "string") {
    const failed = typeof exitCode === "number" && exitCode !== 0;
    const parts = [stdout, stderr, failed ? `exit code ${exitCode}` : ""];
    const printed = parts.map((part) => (typeof part === "string" ? part.trimEnd() : ""));
    return { failed, output: printed.filter((part) => part !== "").join("\n") };
  }
  if (typeof error === "string" && error !== "") return { failed: true, output: error };
  return { failed: false, output: text };
}

/** One entry of a result that is a list: a piece of text, or a page a search found. */
function lineOf(entry: JsonRecord): string {
  if (typeof entry.text === "string") return entry.text;
  if (typeof entry.url !== "string") return "";
  return typeof entry.title === "string" ? `${entry.title} (${entry.url})` : entry.url;
}

function parsedRecord(text: string): JsonRecord | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keeps account of the tool uses of one turn, so that each is reported as started once,
 * detailed at most once and ended once, however often the daemon mentions it. Each method
 * returns the events its news amounts to, in the order to report them.
 */
export class ToolLedger {
  /** Every tool use reported as started, with what is known about it. */
  readonly #uses = new Map<string, ToolUse>();
  readonly #ended = new Set<string>();

  /** The assistant is writing a tool use: all that is known is which tool. */
  named(toolUseId: unknown, toolName: unknown): ToolEvent[] {
    if (typeof toolUseId !== "string" || toolUseId === "") return [];
    if (typeof toolName !== "string" || toolName === "" || this.#uses.has(toolUseId)) return [];
    const toolUse = { toolUseId, toolName };
    this.#uses.set(toolUseId, toolUse);
    return [{ type: "tool-started", toolUse }];
  }

  /**
   * The transcript holds this tool activity. The result of a tool use that was never reported
   * as started is dropped: it belongs to a turn that was not followed from its start.
   */
  recorded(activity: ToolActivity): ToolEvent[] {
    return activity.flatMap((entry) =>
      entry.use === undefined ? this.#resulted(entry.result) : this.#used(entry.use),
    );
  }

  /**
   * The model call is tried again. The tool uses it was writing, which the daemon never came
   * to record, will not happen: they end as failed.
   */
  retried(): ToolEvent[] {
    return this.#close((toolUse) => (toolUse.input === undefined ? true : undefined));
  }

  /**
   * The turn is over. A tool use that is still open did not finish, and one the daemon never
   * recorded did not even run: they end as failed, except that a turn that completed has
   * completed what it ran.
   */
  turnEnded(completed: boolean): ToolEvent[] {
    return this.#close((toolUse) => !completed || toolUse.input === undefined);
  }

  /** Ends the open tool uses for which `failed` says how, without output. */
  #close(failed: (toolUse: ToolUse) => boolean | undefined): ToolEvent[] {
    return [...this.#uses.values()].flatMap((toolUse): ToolEvent[] => {
      const outcome = this.#ended.has(toolUse.toolUseId) ? undefined : failed(toolUse);
      if (outcome === undefined) return [];
      this.#ended.add(toolUse.toolUseId);
      return [{ type: "tool-ended", toolUse, failed: outcome, output: "" }];
    });
  }

  #used(toolUse: ToolUse): ToolEvent[] {
    const known = this.#uses.get(toolUse.toolUseId);
    // The transcript can be read again after a result has come in: that is no news.
    if (known?.input !== undefined || this.#ended.has(toolUse.toolUseId)) return [];
    this.#uses.set(toolUse.toolUseId, toolUse);
    return [{ type: known === undefined ? "tool-started" : "tool-detailed", toolUse }];
  }

  #resulted({ toolUseId, failed, output }: ToolResult): ToolEvent[] {
    const toolUse = this.#uses.get(toolUseId);
    if (toolUse === undefined || this.#ended.has(toolUseId)) return [];
    this.#ended.add(toolUseId);
    return [{ type: "tool-ended", toolUse, failed, output }];
  }
}
