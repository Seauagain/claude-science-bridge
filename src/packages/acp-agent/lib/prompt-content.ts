import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { type ContentBlock, RequestError } from "@agentclientprotocol/sdk";
import type { AttachmentFile } from "../../science-daemon/index.ts";
import { INVALID_PARAMS } from "./errors.ts";

/** An ACP prompt as Claude Science receives it: the text of a message and the files that go with it. */
export interface PromptContent {
  readonly text: string;
  readonly attachments: readonly AttachmentFile[];
}

/**
 * The words of a prompt, without its attachments: its text, and links to resources as their
 * URI, each on its own line. This is what a command is recognised by.
 */
export function promptWords(blocks: readonly ContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "resource_link") return [block.uri];
      return [];
    })
    .join("\n");
}

/**
 * What the user typed in a prompt: its first text. A client may add text of its own after it,
 * as T3 Code ends every prompt with a note about itself.
 */
export function typedWords(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))[0] ?? "";
}

/**
 * Renders an ACP prompt as the message Claude Science receives. Text is passed through and
 * links to resources are sent as their URI, each on its own line. Images and embedded resources
 * become attachments, and so does a file that a client saved in one of `attachmentFolders` and
 * named in the text instead of sending it: see {@link savedFiles}.
 *
 * @throws RequestError (invalid params) for content the adapter cannot pass on, such as audio.
 */
export async function promptContent(
  blocks: readonly ContentBlock[],
  attachmentFolders: readonly string[],
): Promise<PromptContent> {
  const texts: string[] = [];
  const saved: AttachmentFile[] = [];
  const sent: AttachmentFile[] = [];
  let images = 0;
  for (const block of blocks) {
    if (block.type === "text") {
      const { text, files } = await savedFiles(block.text, attachmentFolders);
      texts.push(text);
      saved.push(...files);
    } else if (block.type === "resource_link") {
      texts.push(block.uri);
    } else if (block.type === "image") {
      images += 1;
      sent.push({
        name: nameOf(block.uri) ?? `image-${images}.${extensionOf(block.mimeType)}`,
        mimeType: block.mimeType,
        data: Buffer.from(block.data, "base64"),
      });
    } else if (block.type === "resource") {
      const { resource } = block;
      sent.push({
        name: nameOf(resource.uri) ?? "attachment",
        mimeType: resource.mimeType ?? "",
        data:
          "text" in resource ? Buffer.from(resource.text) : Buffer.from(resource.blob, "base64"),
      });
    } else {
      throw new RequestError(
        INVALID_PARAMS,
        `Claude Science sessions take text, images and files; this prompt contains "${block.type}" content.`,
      );
    }
  }
  // A client that names a saved image in the text may send the same image as a block too.
  const fresh = sent.filter((file) => !saved.some((other) => sameBytes(file.data, other.data)));
  return { text: texts.join("\n"), attachments: [...saved, ...fresh] };
}

/**
 * How T3 Code tells an agent about a file the user attached: it saves the file on this computer
 * and adds a line that names it to the prompt's text. Claude Science works in a sandbox that
 * cannot read that path, so the file itself has to be sent. See ADR 0007.
 */
const SAVED_FILE =
  /^\[Attached (?:image|file) "(.*)" is saved at: (.+?)(?: \(text extracted to: .+\))?\]$/;

/**
 * Takes the files out of a text that names them as saved on this computer. A file that lies in
 * one of `folders` and can be read becomes an attachment and its line is dropped; any other line
 * stays as it is.
 */
async function savedFiles(
  text: string,
  folders: readonly string[],
): Promise<{ text: string; files: AttachmentFile[] }> {
  const files: AttachmentFile[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const [, name, path] = SAVED_FILE.exec(line) ?? [];
    const data =
      name === undefined || path === undefined ? undefined : await savedFile(path, folders);
    if (data === undefined || name === undefined) {
      kept.push(line);
    } else {
      // The daemon tells the media type by the file's name.
      files.push({ name, mimeType: "", data });
    }
  }
  if (files.length === 0) return { text, files };
  // The lines stood in paragraphs of their own: close the gaps they leave.
  return {
    text: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    files,
  };
}

/**
 * The content of a file a client saved in one of `folders`. Nothing for a path anywhere else:
 * a prompt can hold a line in a client's wording that the client did not write, such as pasted
 * text, and that line must not send a file the user never attached. Nothing either for a file
 * that cannot be read, which is no failure of the prompt. See ADR 0008.
 */
async function savedFile(path: string, folders: readonly string[]): Promise<Buffer | undefined> {
  if (!isAbsolute(path)) return undefined;
  // Links are followed before the comparison, so that a path cannot leave a folder through one.
  const file = await realpath(path).catch(() => undefined);
  if (file === undefined) return undefined;
  for (const folder of folders) {
    const root = await realpath(folder).catch(() => undefined);
    if (root !== undefined && isInside(root, file)) return readFile(file).catch(() => undefined);
  }
  return undefined;
}

function isInside(folder: string, file: string): boolean {
  const [first] = relative(folder, file).split(sep);
  return first !== undefined && first !== "" && first !== ".." && !isAbsolute(first);
}

/** The file name a URI ends in, when it has one. */
function nameOf(uri: string | null | undefined): string | undefined {
  if (uri === undefined || uri === null) return undefined;
  let path = uri;
  try {
    path = decodeURIComponent(new URL(uri).pathname);
  } catch {
    // Not a URI: taken as a path.
  }
  const name = basename(path);
  return name === "" ? undefined : name;
}

/** The file extension that goes with an image's media type. */
function extensionOf(mimeType: string): string {
  const subtype = (mimeType.split("/")[1] ?? "").split(/[+;]/)[0] ?? "";
  if (subtype === "jpeg") return "jpg";
  return /^[a-z0-9]+$/.test(subtype) ? subtype : "png";
}

function sameBytes(one: Uint8Array, other: Uint8Array): boolean {
  return one.length === other.length && Buffer.from(one).equals(other);
}
