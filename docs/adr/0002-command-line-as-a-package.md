# 2. The command line is a package, and the agent finds project links itself

Date: 2026-11-15

## Context

The first design put the commands in `src/commands/` as application code outside the packages,
and had the `acp-agent` package receive a function that resolves a folder to a project.

## Decision

- The command line is the package `cli`. Its interface is one function that takes the arguments
  and the process surroundings (standard streams, environment, working folder) and returns an exit
  code. `src/main.ts` only hands the real process to it.
- `acp-agent` imports `findProjectLink` from the `project-link` package directly instead of
  receiving a resolver function.

## Why

- As a package, the command line gets the same rules as everything else: a small interface, and
  tests that can only go through it. Every command is tested by calling that one function with
  in-memory streams.
- A resolver parameter would be a seam with a single implementation. Project links are files, and
  the tests use real temporary folders, so nothing varies across that seam.

## Consequences

`acp-agent` depends on `project-link` and `science-daemon`; `cli` depends on all three. No package
depends on `cli`.
