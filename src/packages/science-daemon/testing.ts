/**
 * Test support: a fake Claude Science daemon that serves HTTP and WebSocket on loopback and
 * implements docs/protocol.md. Not part of the built program.
 */
export type { FakeConversation, FakeTurn, ReplyScript } from "./lib/fake/fake-conversations.ts";
export { type FakeScienceDaemon, startFakeScienceDaemon } from "./lib/fake/fake-daemon.ts";
