import { ScienceDaemonError } from "./errors.ts";

/** A JSON object whose fields have not been checked yet. */
export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns `value` as a JSON object, or fails naming the `call` that produced it. */
export function expectRecord(value: unknown, call: string): JsonRecord {
  if (isRecord(value)) return value;
  throw unexpected(call, "expected a JSON object");
}

/** Returns the string field `field` of `record`, or fails naming the `call` that produced it. */
export function expectString(record: JsonRecord, field: string, call: string): string {
  const value = record[field];
  if (typeof value === "string" && value !== "") return value;
  throw unexpected(call, `expected a non-empty string in "${field}"`);
}

/** Returns the number field `field` of `record`, or fails naming the `call` that produced it. */
export function expectNumber(record: JsonRecord, field: string, call: string): number {
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw unexpected(call, `expected a number in "${field}"`);
}

function unexpected(call: string, problem: string): ScienceDaemonError {
  return new ScienceDaemonError(
    "unexpected-response",
    `Claude Science answered "${call}" in a way csbridge does not understand (${problem}). ` +
      "This version of csbridge may not support this version of Claude Science: " +
      "`csbridge doctor` tells whether it was tested with it.",
  );
}
