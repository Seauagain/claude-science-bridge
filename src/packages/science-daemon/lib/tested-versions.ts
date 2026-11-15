/**
 * The versions of Claude Science this release of csbridge was tested with. The daemon's interface
 * is internal and can change with any update, so every other version is used with a warning.
 * Add a version once the manual check against the real daemon has passed with it, and record it
 * in docs/protocol.md.
 */
const TESTED_VERSIONS: readonly string[] = ["0.1.53"];

/** The warning to give for daemon `version`, or `undefined` when this release was tested with it. */
export function untestedVersionWarning(version: string): string | undefined {
  if (TESTED_VERSIONS.includes(version)) return undefined;
  return (
    `Claude Science ${version} has not been tested with this version of csbridge ` +
    `(tested: ${TESTED_VERSIONS.join(", ")}). It may work; if something fails, look for a newer csbridge.`
  );
}
