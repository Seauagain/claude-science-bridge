import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { INTERNAL_ERROR } from "./errors.ts";

/**
 * The record of which session belongs to which conversation, kept on disk so that a session
 * outlives the adapter process that opened it. It holds identifiers only.
 *
 * Every method reads or writes the file anew: the client runs one adapter process per thread,
 * and they all share the record.
 */
export interface SessionRecord {
  /** Records that `sessionId` is the client's handle on `conversationId`, for good. */
  remember(sessionId: string, conversationId: string): Promise<void>;
  /** The conversation a session was recorded for, by this process or any other. */
  conversationOf(sessionId: string): Promise<string | undefined>;
  /** The conversations that have a session on record. */
  takenConversations(): Promise<ReadonlySet<string>>;
}

/**
 * Opens the record kept in `stateFolder`. Nothing is created until the first pair is
 * remembered, and a record that does not exist yet is an empty one.
 *
 * The file is `sessions.jsonl`: one line per pair, a JSON object with `sessionId` and
 * `conversationId`. Pairs are only ever appended, each with a single short write, which is what
 * lets several processes add to the file at once without a lock.
 */
export function openSessionRecord(stateFolder: string): SessionRecord {
  const file = join(stateFolder, "sessions.jsonl");

  const readPairs = async (): Promise<Map<string, string>> => {
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return new Map();
      throw new RequestError(
        INTERNAL_ERROR,
        `csbridge cannot read its session record ${file}: ${describe(error)}. ` +
          `Check that ${stateFolder} is a folder you can read and write.`,
      );
    }
    const pairs = new Map<string, string>();
    for (const line of contents.split("\n")) {
      const pair = parsePair(line);
      if (pair !== undefined) pairs.set(pair.sessionId, pair.conversationId);
    }
    return pairs;
  };

  return {
    async remember(sessionId, conversationId) {
      try {
        await mkdir(stateFolder, { recursive: true });
        await appendFile(file, `${JSON.stringify({ sessionId, conversationId })}\n`, "utf8");
      } catch (error) {
        throw new RequestError(
          INTERNAL_ERROR,
          `csbridge could not record this session in ${file}: ${describe(error)}. ` +
            "Your message was sent and Claude Science is answering it, but this thread will " +
            `not be found again once the adapter has restarted. Check that ${stateFolder} is ` +
            "a folder you can write to.",
        );
      }
    },
    conversationOf: async (sessionId) => (await readPairs()).get(sessionId),
    takenConversations: async () => new Set((await readPairs()).values()),
  };
}

/**
 * One line of the record. A line that is not a pair is passed over, so that one damaged line,
 * for example of a process that died while writing it, does not cost every other session.
 */
function parsePair(line: string): { sessionId: string; conversationId: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { sessionId, conversationId } = value;
  if (typeof sessionId !== "string" || typeof conversationId !== "string") return undefined;
  return { sessionId, conversationId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
