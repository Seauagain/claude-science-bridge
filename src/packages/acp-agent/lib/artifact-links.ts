import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactFile, ScienceDaemon } from "../../science-daemon/index.ts";

/**
 * Finds the file of an artifact version on this computer: resolves to its full path, or to
 * nothing when the file cannot be had.
 */
export type ArtifactLocator = (versionId: string) => Promise<string | undefined>;

/** What a version's identifier looks like. It becomes the name of a folder. */
const VERSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The artifacts of Claude Science as files below `folder`, which is csbridge's own: a version is
 * fetched from the daemon the first time it is asked for and saved as
 * `<folder>/<version identifier>/<file name>`. A version never changes, so a saved one is not
 * fetched again.
 *
 * A reply names a file it made by a marker that only Claude Science's own page can follow. A
 * client shows a file it is given the path of, so the file has to be on this computer.
 */
export function savedArtifacts(
  folder: string,
  daemon: () => Promise<ScienceDaemon>,
): ArtifactLocator {
  return async (versionId) => {
    if (!VERSION_ID.test(versionId)) return undefined;
    const home = join(folder, versionId);
    try {
      const saved = await savedIn(home);
      return saved ?? (await save(home, await (await daemon()).readArtifact(versionId)));
    } catch {
      // The daemon has no such version or cannot be reached, or the file cannot be written.
      // None of it is a reason to stop a reply: it goes on without the file.
      return undefined;
    }
  };
}

/** The file that was saved in a version's folder, if any. */
async function savedIn(home: string): Promise<string | undefined> {
  const names = await readdir(home).catch(() => []);
  const name = names.find((each) => !each.startsWith("."));
  return name === undefined ? undefined : join(home, name);
}

async function save(home: string, artifact: ArtifactFile): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = join(home, nameOf(artifact.filename));
  // Written under another name first, so that a file cut short is never taken for the artifact.
  const unfinished = join(home, `.${randomUUID()}.part`);
  await writeFile(unfinished, artifact.data);
  await rename(unfinished, file);
  return file;
}

/** A file name that is safe in a folder and in a Markdown link, from the artifact's own. */
function nameOf(filename: string): string {
  const name = (filename.split(/[/\\]/).pop() ?? "").replace(/[\p{Cc}<>]/gu, "_");
  return name === "" || name.startsWith(".") ? "artifact" : name;
}

/** A Markdown link or image whose destination is an artifact marker. */
const LINK = /\]\(\{\{artifact:([A-Za-z0-9_-]{1,64})\}\}\)/g;
/** How such a link begins, from the bracket that closes its text. */
const OPENING = "]({{artifact:";
/** What can follow the opening in a link that has not ended yet. */
const UNFINISHED = /^[A-Za-z0-9_-]{0,64}\}{0,2}$/;

/**
 * `text` with every Markdown link and image that points at an artifact marker pointing at the
 * artifact's file instead. One whose file cannot be had stays as it is written. A marker
 * anywhere else, as in code that reads the artifact, is left alone.
 */
async function withArtifactsLocated(text: string, locate: ArtifactLocator): Promise<string> {
  let located = "";
  let from = 0;
  for (const match of text.matchAll(LINK)) {
    const [link, versionId = ""] = match;
    const path = await locate(versionId);
    const destination = path === undefined ? undefined : destinationOf(path);
    located += text.slice(from, match.index);
    located += destination === undefined ? link : `](${destination})`;
    from = match.index + link.length;
  }
  return located + text.slice(from);
}

/** `path` as the destination of a Markdown link, or nothing when it cannot be one. */
function destinationOf(path: string): string | undefined {
  if (/[<>\\\n\r]/.test(path)) return undefined;
  // In pointed brackets a destination may hold spaces and brackets.
  return /[\s()]/.test(path) ? `<${path}>` : path;
}

/**
 * Reply text on its way to a client, piece by piece. A link to an artifact comes out pointing at
 * the artifact's file. Text is held back only from where such a link may have begun to where it
 * ends, so a reply still arrives as it is written.
 */
export class PassingLinks {
  readonly #locate: ArtifactLocator;
  #held = "";

  constructor(locate: ArtifactLocator) {
    this.#locate = locate;
  }

  /** Takes the next piece and returns what can go to the client now, which may be nothing. */
  add(piece: string): Promise<string> {
    return this.#pass(piece, false);
  }

  /** Returns the rest: the reply has ended, or goes on with something that is not text. */
  end(): Promise<string> {
    return this.#pass("", true);
  }

  async #pass(piece: string, complete: boolean): Promise<string> {
    const text = await withArtifactsLocated(this.#held + piece, this.#locate);
    const ready = complete ? text.length : unfinishedLinkIn(text);
    this.#held = text.slice(ready);
    return text.slice(0, ready);
  }
}

/** Where a link to an artifact begins that `text` ends in the middle of, or the end of `text`. */
function unfinishedLinkIn(text: string): number {
  // No character of such a link but its first is a closing bracket.
  const start = text.lastIndexOf("]");
  if (start === -1) return text.length;
  const tail = text.slice(start);
  const unfinished =
    tail.length <= OPENING.length
      ? OPENING.startsWith(tail)
      : tail.startsWith(OPENING) && UNFINISHED.test(tail.slice(OPENING.length));
  return unfinished ? start : text.length;
}
