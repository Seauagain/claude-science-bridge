# 3. After a reconnect, a turn's text comes from the transcript

Date: 2026-11-15

## Context

Reply text arrives as `text_chunk` events on the event socket. When the socket drops during a
turn, chunks sent in the meantime are lost. The daemon offers no way to replay events, but the
conversation's messages can be read over HTTP.

Trusting live chunks again after reopening the socket leaves a hole in the reply: the text from
before the gap, then the text from after it, with the middle missing.

## Decision

Once the socket has been reopened during a turn, the adapter stops delivering live chunks for that
turn. It reads the frame status and the conversation's messages right after reopening and whenever
the frame reports a terminal status, and delivers the part of the last assistant message that it
has not delivered yet.

## Consequences

- No holes and no repeated text in the common case of a reply that is one assistant message.
- After a reconnect, text can arrive late, possibly only when the turn ends.
- In a turn with several assistant messages (a reply that uses tools), text of the earlier
  messages that was streamed during or after the gap is not delivered. It stays in Claude Science.
  This is stated in the README and is expected to be solved together with showing tool activity.
- Matching "already delivered" text against the transcript is by overlap of characters. A message
  that starts with the same characters the delivered text ends with would lose them. Accepted as
  rare; revisit if it is ever observed.
