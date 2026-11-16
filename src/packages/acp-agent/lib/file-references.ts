import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A full path as it stands in what a tool was given or gave back, alone or inside code. */
const FULL_PATH = /(?<![\w.~@+-])\/(?:[\w.@+~-]+\/)*[\w.@+~-]+/g;
/** What a code span holds when it names a file by a relative path. */
const RELATIVE_PATH = /^[\w.@+-][\w.@+~-]*(?:\/[\w.@+~-]+)*$/;
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
/** More folders than this are not remembered: every one costs a look at the disk per file. */
const MOST_FOLDERS = 400;
/** A code span longer than this is not a file name, and is not waited for. */
const LONGEST_SPAN = 400;

/**
 * Where the files are that a conversation's replies name.
 *
 * Claude Science names a file relative to the folder it works in, and that folder is not the
 * session's: a client that resolves the path against the session's folder finds nothing. The
 * tools are given full paths, though. So the folders the tools worked in are remembered, and a
 * relative path that is exactly one file below one of them is known by its full path.
 *
 * Paths are those of a POSIX file system, which is where the daemon runs.
 */
export class FileReferences {
  readonly #sessionFolder: string;
  readonly #folders = new Set<string>();
  readonly #located = new Map<string, string | undefined>();

  constructor(sessionFolder: string) {
    this.#sessionFolder = sessionFolder;
  }

  /** Remembers the folders named in what a tool was given or gave back, and those above them. */
  learn(value: unknown): void {
    if (typeof value === "string") {
      for (const [path] of value.matchAll(FULL_PATH)) this.#remember(path);
    } else if (Array.isArray(value)) {
      for (const item of value) this.learn(item);
    } else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) this.learn(item);
    }
  }

  #remember(path: string): void {
    for (let folder = path; folder !== "/" && folder !== "."; folder = dirname(folder)) {
      if (this.#folders.has(folder) || this.#folders.size >= MOST_FOLDERS) return;
      this.#folders.add(folder);
      // What is known about a file can change with every folder.
      this.#located.clear();
    }
  }

  /**
   * The full path of the file that `reference` names, when it is a relative path to exactly one
   * file below the remembered folders. Nothing for a file the session's own folder has, which
   * the client finds by itself, and for a reference that fits no file or more than one.
   */
  async locate(reference: string): Promise<string | undefined> {
    const names = reference.includes("/") || FILE_EXTENSION.test(reference);
    if (!names || !RELATIVE_PATH.test(reference)) return undefined;
    if (!this.#located.has(reference)) this.#located.set(reference, await this.#find(reference));
    return this.#located.get(reference);
  }

  async #find(reference: string): Promise<string | undefined> {
    if (await isFile(join(this.#sessionFolder, reference))) return undefined;
    let found: string | undefined;
    for (const folder of this.#folders) {
      const candidate = join(folder, reference);
      if (!(await isFile(candidate))) continue;
      if (found !== undefined) return undefined;
      found = candidate;
    }
    return found;
  }

  /** `text` with the files its code spans name given by their full paths. */
  async located(text: string): Promise<string> {
    const passing = new PassingText(this);
    return (await passing.add(text)) + (await passing.end());
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    // Not there, or not to be read: either way it is not a file to point a client at.
    return false;
  }
}

/**
 * Reply text on its way to a client, piece by piece. A code span that names a file comes out
 * naming it by its full path. Text is held back only from the start of a code span to its end,
 * so a reply still arrives as it is written. Code blocks pass as they are.
 */
export class PassingText {
  readonly #files: FileReferences;
  #held = "";
  /** The length of the run of backticks that opened the code block the text is in, if any. */
  #blockFence: number | undefined;

  constructor(files: FileReferences) {
    this.#files = files;
  }

  /** Takes the next piece and returns what can go to the client now, which may be nothing. */
  add(piece: string): Promise<string> {
    this.#held += piece;
    return this.#pass(false);
  }

  /**
   * Returns the rest: the reply has ended, or goes on with something that is not text. What was
   * held back is complete now, so a code span that closed at its very end is still looked at.
   */
  async end(): Promise<string> {
    const rest = await this.#pass(true);
    this.#blockFence = undefined;
    return rest;
  }

  /** Passes what is held as far as it can be told what it is. `complete`: no more text follows. */
  async #pass(complete: boolean): Promise<string> {
    let ready = "";
    for (;;) {
      const start = this.#held.indexOf("`");
      if (start === -1) return ready + this.#release(this.#held.length);
      const afterRun = endOfRun(this.#held, start);
      // The run may go on in the next piece: how long it is decides what it opens or closes.
      if (afterRun === this.#held.length && !complete) return ready + this.#release(start);
      const run = afterRun - start;

      if (this.#blockFence !== undefined || run >= 3) {
        const closes = this.#blockFence !== undefined && run >= this.#blockFence;
        this.#blockFence = closes ? undefined : (this.#blockFence ?? run);
        ready += this.#release(afterRun);
        continue;
      }

      const span = this.#spanFrom(afterRun, run, complete);
      if (span === "open") return ready + this.#release(start);
      if (span === undefined) {
        ready += this.#release(afterRun);
        continue;
      }
      const content = this.#held.slice(afterRun, span);
      const fence = "`".repeat(run);
      ready += this.#held.slice(0, start) + fence;
      ready += ((await this.#files.locate(content)) ?? content) + fence;
      this.#held = this.#held.slice(span + run);
    }
  }

  /**
   * Where the code span that opened with `run` backticks before `from` closes: the position of
   * its closing run, `"open"` while that may still come, and nothing when it cannot, which makes
   * the opening run ordinary text. A span closes on the line it opened on.
   */
  #spanFrom(from: number, run: number, complete: boolean): number | "open" | undefined {
    const lineEnd = this.#held.indexOf("\n", from);
    const line = lineEnd === -1 ? this.#held.length : lineEnd;
    for (let at = this.#held.indexOf("`", from); at !== -1 && at < line; ) {
      const after = endOfRun(this.#held, at);
      if (after === this.#held.length && !complete) return "open";
      if (after - at === run) return at;
      at = this.#held.indexOf("`", after);
    }
    const mayClose = !complete && lineEnd === -1 && this.#held.length - from <= LONGEST_SPAN;
    return mayClose ? "open" : undefined;
  }

  #release(length: number): string {
    const released = this.#held.slice(0, length);
    this.#held = this.#held.slice(length);
    return released;
  }
}

/** The position after the run of backticks that starts at `start`. */
function endOfRun(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end++;
  return end;
}
