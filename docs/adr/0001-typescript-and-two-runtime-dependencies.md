# 1. TypeScript on Node.js with two runtime dependencies

Date: 2026-11-15

## Context

The adapter is a small long-running program that speaks ACP over standard input and output and
HTTP plus WebSocket to a daemon on loopback. It should install without a compiler toolchain and
run the same on macOS and Linux.

## Decision

TypeScript in strict mode on Node.js 22 or newer, built with `tsc` and nothing else. Two runtime
dependencies:

- `@agentclientprotocol/sdk`, the reference implementation of ACP, for the protocol.
- `ws`, because the daemon's WebSocket handshake needs cookies and an `origin` header, which the
  WebSocket built into Node.js cannot send.

HTTP uses the built-in `fetch`. Responses are validated with a few hand-written checks instead of
a schema library. TypeScript is pinned to the 6.x line because dependency-cruiser, which enforces
the package boundaries, does not support 7.x yet.

## Alternatives considered

- Python: the standard library has SQLite, which the planned exporter needs, and a Python ACP
  library is known to work with T3 Code. Rejected by the repository owner in favour of TypeScript.
- A bundler: not needed for a program of this size.

## Consequences

Any further runtime dependency needs its own ADR.
