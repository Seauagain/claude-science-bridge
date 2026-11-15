# 4. Cancellation is a signal passed with the message

Date: 2026-11-15

## Context

ACP requires a prompt that the client cancelled to answer with the stop reason `cancelled`. The
first design gave a turn a `cancel()` method. Review found three ways that broke the requirement:
the turn could fail after the cancel and surface as an error; a cancel that arrived before the
message had been sent had no turn to cancel; and a daemon that took the cancel request without
ending the turn left the prompt waiting forever.

## Decision

A message is sent together with an `AbortSignal`. The `science-daemon` package owns everything
that follows from aborting it and guarantees the outcome:

- aborted before the message is sent: the message is not sent and the call fails as cancelled;
- aborted during a turn: the daemon is asked to cancel, and the turn's events end with the outcome
  `cancelled`, whatever else happens afterwards (a failure, a lost connection, a reply that
  finished before it could be stopped);
- no confirmation from the daemon within 10 s of the abort: the turn ends as cancelled anyway.

The `acp-agent` package holds one `AbortController` per prompt and aborts it on `session/cancel`.

## Consequences

- The agent has no cancellation logic of its own beyond aborting the signal.
- After a cancel that the daemon did not confirm, its turn may still be running. What the daemon
  then answers to the next message is unknown (see the open questions in docs/protocol.md).
