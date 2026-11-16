import type { DaemonHttp } from "./http.ts";
import { expectNumber, expectRecord, expectString } from "./validate.ts";

/** A file to send along with a message. */
export interface AttachmentFile {
  /** The file's name, as the conversation shows it. */
  readonly name: string;
  /**
   * The file's media type. Leave it empty when it is not known: the daemon then tells by the
   * name.
   */
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/** A file the daemon holds for a project, ready to be named in a message. */
interface Attachment {
  readonly id: string;
  readonly versionId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

const UPLOAD_CALL = "POST /projects/<id>/attachments";

/**
 * Hands the daemon the files of a message and returns the message as it has to be sent for them
 * to be attached: each file's reference in front of the text, as the daemon's web client writes
 * it. See "Attachments" in docs/protocol.md.
 *
 * @throws ScienceDaemonError when the daemon refuses a file, as it does an empty one or one that
 *   is too large for it.
 */
export async function messageWithAttachments(
  http: DaemonHttp,
  projectId: string,
  message: string,
  files: readonly AttachmentFile[],
): Promise<string> {
  if (files.length === 0) return message;
  const references: string[] = [];
  // One after the other: the references keep the order the user attached the files in.
  for (const file of files) references.push(reference(await upload(http, projectId, file)));
  const head = references.join(" ");
  return message === "" ? head : `${head}\n${message}`;
}

async function upload(
  http: DaemonHttp,
  projectId: string,
  file: AttachmentFile,
): Promise<Attachment> {
  const stored = expectRecord(
    await http.upload(`/projects/${encodeURIComponent(projectId)}/attachments`, file),
    UPLOAD_CALL,
  );
  return {
    id: expectString(stored, "id", UPLOAD_CALL),
    versionId: expectString(stored, "version_id", UPLOAD_CALL),
    filename: expectString(stored, "filename", UPLOAD_CALL),
    contentType: expectString(stored, "content_type", UPLOAD_CALL),
    sizeBytes: expectNumber(stored, "size_bytes", UPLOAD_CALL),
  };
}

/** The line of JSON that stands for an attachment in a message. The key order is the web client's. */
function reference(attachment: Attachment): string {
  return JSON.stringify({
    type: "attachment",
    id: attachment.id,
    version_id: attachment.versionId,
    filename: attachment.filename,
    artifact_ref: `{{artifact:${attachment.versionId}}}`,
    content_type: attachment.contentType,
    size_bytes: attachment.sizeBytes,
  });
}

const REFERENCE =
  /\{"type":"(?:attachment|artifact)","id":"[^"]*","version_id":"[^"]*","filename":"([^"\\]*)","artifact_ref":"\{\{artifact:[^"}]*\}\}","content_type":"[^"]*","size_bytes":\d+\}/g;

/**
 * A message the user sent, with each attachment reference replaced by words that name the file.
 * This is what a transcript shows in place of the reference's JSON.
 */
export function withAttachmentsNamed(message: string): string {
  return message.replace(REFERENCE, (_reference, filename: string) => `[Attached: ${filename}]`);
}

/**
 * Whether a text block of a user message is a note the daemon wrote for the model about one of
 * the message's attachments. The user did not type it.
 */
export function isAttachmentNote(text: string): boolean {
  return (
    text.startsWith("[System] Attachment available: ") ||
    text.startsWith("[System] Attached file: ")
  );
}
