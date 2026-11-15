# Contributing

These are the coding standards reviews are held to. `docs/SPEC.md` has the full rationale.

## Design

- A package is a deep module: a small interface in its root files, implementation in `lib/`,
  tests in `tests/`. Import other packages only through their root files. No barrel files.
- Add a seam only where two implementations actually exist. No abstractions for imagined needs.
- Pass dependencies in as parameters. No module-level mutable state.
- Knowledge of the daemon's interface belongs in `src/packages/science-daemon` and
  `docs/protocol.md`, nowhere else.

## Code

- TypeScript strict mode. No `any`. No type assertions or non-null assertions to silence the
  checker; when one is unavoidable, say why in a comment.
- Validate data from outside (daemon responses, files, CLI output) before it becomes an internal type.
- Throw typed errors with a category. Never swallow an error. A user-facing message says what
  went wrong and what to do next.
- One job per file, about 300 lines at most. Short functions, at most three levels of nesting.
- Full words in names, matching `GLOSSARY.md`.
- Every export of an entry-point file has a doc comment stating purpose and constraints.
- Comments explain why, not what.
- Use `node:path` for paths, explicit UTF-8 for text, argument arrays for child processes.
- Standard output is reserved for the ACP protocol. Log to standard error.
- Never log cookies, nonces or tokens.

## Tests

- Test behaviour through public interfaces, at the seams listed in `docs/SPEC.md` section 7.
- Adapter behaviour is tested from the ACP side against the fake daemon, with nothing replaced
  in between.
- Replace only system boundaries. Never mock a module of this repo.
- Expected values come from the spec or a worked example, never recomputed the way the code does.
- Red before green, one slice at a time.
- Synthetic data only.

## Workflow

- Conventional Commits. One ticket per branch. `pnpm check` passes before every commit.
- A change in behaviour updates the README and CHANGELOG; a new fact about the daemon updates
  `docs/protocol.md`; a design decision gets an ADR in `docs/adr/`.
