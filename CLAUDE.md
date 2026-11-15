# claude-science-bridge

An unofficial ACP adapter that lets ACP clients (T3 Code, Zed) chat with the local Claude Science
daemon. Read these before changing code:

- [docs/SPEC.md](./docs/SPEC.md): requirements, architecture, process. The single source of truth.
- [docs/protocol.md](./docs/protocol.md): everything known about the daemon's interface.
- [GLOSSARY.md](./GLOSSARY.md): domain vocabulary. Use these terms in code, tests and tickets.
- [CONTRIBUTING.md](./CONTRIBUTING.md): coding standards.
- Packages are deep modules: see [src/packages/README.md](./src/packages/README.md) before adding
  or importing one.

## Commands

- `pnpm install`: run once in every new worktree.
- `pnpm check`: typecheck, lint, module boundaries, tests with coverage. Must pass before a commit.
- `pnpm test:watch`: the red-green loop.
- `pnpm lint:fix`: apply formatting and safe lint fixes.

## Hard rules

- Standard output belongs to the ACP protocol. Log to standard error only.
- Never print, log or commit cookies, nonces or tokens.
- Test data is synthetic. No real conversations, project names or personal paths in the repo.
- Never write into the Claude Science data directory.
- Do not talk to the real daemon from automated tests. The fake daemon implements `protocol.md`.
- Sending a message to the real daemon needs the repository owner's explicit go-ahead.
- Code, comments, commit messages and tickets are in English.

## Agent skills

The engineering skills live in `~/Projects/skills/mattpocock-skills/skills/`. Read a skill's
`SKILL.md` and follow it when a step calls for it: `engineering/tdd`, `engineering/codebase-design`,
`engineering/code-review`, `engineering/pr`, `engineering/to-tickets`, `engineering/implement-spec`.

### Issue tracker

Issues and tickets live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
