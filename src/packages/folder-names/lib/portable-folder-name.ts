/**
 * The longest folder name produced, in characters. A file system allows 255 bytes or UTF-16
 * units for one name; 60 characters stay below that whatever the script (at most four bytes
 * each), and leave room in the 260 characters Windows allows for a whole path.
 */
export const LONGEST_FOLDER_NAME = 60;

/** Stands in for a name of which nothing is left. */
const NAMELESS = "Untitled project";

/** Characters Windows does not allow in a name. macOS and Linux only refuse the slash. */
const FORBIDDEN_CHARACTERS = '<>:"/\\|?*';

/** Names Windows reserves for devices, whatever their letter case and with any extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** Windows silently drops dots and spaces at the end of a name, so two names could become one. */
const TRAILING_DOTS_AND_SPACES = /[.\s]+$/u;

/**
 * Turns any text into a folder name that is valid on macOS, Linux and Windows, changing as
 * little as possible: letters of every script are kept.
 *
 * @param longest how many characters the name may have at most.
 */
export function portableFolderName(text: string, longest = LONGEST_FOLDER_NAME): string {
  const allowed = Array.from(text.trim(), (character) =>
    isAllowed(character) ? character : "_",
  ).join("");
  const guarded = DEVICE_NAME.test(allowed) ? `_${allowed}` : allowed;
  // Counted in whole characters, so that an emoji or a rare ideograph is never cut in half.
  const shortened = Array.from(guarded).slice(0, longest).join("");
  return shortened.replace(TRAILING_DOTS_AND_SPACES, "") || NAMELESS;
}

function isAllowed(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  const isControl = code < 0x20 || code === 0x7f;
  return !isControl && !FORBIDDEN_CHARACTERS.includes(character);
}
