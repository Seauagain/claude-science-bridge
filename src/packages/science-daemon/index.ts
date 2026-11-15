/**
 * The local Claude Science daemon: finding it, logging in, starting conversations and following
 * their turns. Everything this project knows about the daemon's interface is behind this file;
 * docs/protocol.md is the written counterpart.
 */
export { type ConnectOptions, connectScienceDaemon, type ScienceDaemon } from "./lib/connect.ts";
export type { Conversation } from "./lib/conversations.ts";
export { ScienceDaemonError, type ScienceDaemonErrorKind } from "./lib/errors.ts";
export type { Project } from "./lib/projects.ts";
export { createScienceCli, type ScienceCliOptions } from "./lib/real-science-cli.ts";
export type { ScienceCli } from "./lib/science-cli.ts";
export { checkDaemonSetup, type SetupCheck } from "./lib/setup-check.ts";
export type { ConnectionTiming } from "./lib/timing.ts";
export type { TranscriptEntry } from "./lib/transcript.ts";
export type { Turn, TurnEvent, TurnOutcome } from "./lib/turn.ts";
