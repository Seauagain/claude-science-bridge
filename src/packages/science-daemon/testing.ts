/**
 * Test support: a fake Claude Science daemon that serves HTTP and WebSocket on loopback and
 * implements docs/protocol.md. Not part of the built program.
 */
export {
  type FakeConversation,
  type FakeScienceDaemon,
  type FakeTurn,
  type ReplyScript,
  startFakeScienceDaemon,
} from "./lib/fake/fake-daemon.ts";
