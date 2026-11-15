# Packages

Every folder here is a **deep module**: a lot of behaviour behind a small interface.

```
src/packages/<name>/
  index.ts      an entry point: import this from outside
  testing.ts    optional second entry point with test stand-ins
  lib/          implementation, private to the package
  tests/        tests and fixtures, private to the package
```

A package's public surface is the files at its root. Anything in a subfolder is private.

## Rules

Enforced by `pnpm lint:boundaries` (dependency-cruiser). A violation fails `pnpm check`.

1. **Entry-point boundary.** Code outside a package imports only that package's root files,
   never anything in its subfolders.
2. **Intra-package freedom.** A package's own files import each other freely.
3. **Tests through the entry points.** Files under `tests/` import entry points and their own
   fixtures, never `lib/`, not even their own package's.
4. **No cycles.**

## No barrel files

Do not re-export a whole subtree through one `index.ts`. Expose a few small entry points, each
with only what callers need, and keep everything else in `lib/`.
