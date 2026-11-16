import type { IncomingMessage } from "node:http";
import { buffer } from "node:stream/consumers";
import type { Answer } from "./http-exchange.ts";

/** A file the fake daemon was handed for a project. */
export interface FakeAttachment {
  readonly projectId: string;
  readonly filename: string;
  /** The media type the upload named, or the one the daemon told by the file's name. */
  readonly contentType: string;
  readonly data: Uint8Array;
}

/** The media types the fake tells by a file's name, as the daemon does for an upload without one. */
const TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  txt: "text/plain",
  csv: "text/csv",
};

const UNNAMED_TYPE = "application/octet-stream";

/** The attachments of the fake daemon's projects. See "Attachments" in docs/protocol.md. */
export class FakeAttachments {
  readonly #attachments: FakeAttachment[] = [];

  all(): FakeAttachment[] {
    return [...this.#attachments];
  }

  /** `POST /projects/<project_id>/attachments`, for a project that exists. */
  async upload(projectId: string, request: IncomingMessage): Promise<Answer> {
    const form = await new Response(await buffer(request), {
      headers: { "content-type": request.headers["content-type"] ?? "" },
    }).formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return { status: 400, body: { detail: "fake daemon: the form holds no file" } };
    }
    if (file.size === 0) return { status: 400, body: { detail: "Cannot upload empty file" } };

    const extension = file.name.split(".").pop() ?? "";
    // A form part without a media type arrives as `application/octet-stream`, and the daemon
    // then tells by the file's name.
    const named = file.type === "" || file.type === UNNAMED_TYPE ? undefined : file.type;
    const contentType = named ?? TYPES_BY_EXTENSION[extension] ?? UNNAMED_TYPE;
    this.#attachments.push({
      projectId,
      filename: file.name,
      contentType,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    const number = this.#attachments.length;
    return {
      status: 200,
      body: {
        id: `attachment-${number}`,
        version_id: `version-${number}`,
        filename: file.name,
        content_type: contentType,
        size_bytes: file.size,
      },
    };
  }
}
