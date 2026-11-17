/**
 * Test support: a fake Claude Science daemon that serves HTTP and WebSocket on loopback and
 * implements docs/protocol.md. Not part of the built program.
 */
export type { FakeAttachment } from "./lib/fake/fake-attachments.ts";
export type {
  ExistingConversation,
  ExistingMessage,
  FakeConversation,
  FakeTool,
  FakeToolUse,
  FakeTurn,
  ReplyScript,
} from "./lib/fake/fake-conversation.ts";
export { startFakeScienceDaemon } from "./lib/fake/fake-daemon.ts";
export type { FakeProject } from "./lib/fake/fake-projects.ts";
export type { FakeScienceDaemon } from "./lib/fake/fake-science-daemon.ts";
