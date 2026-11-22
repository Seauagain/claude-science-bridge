import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { sendJson } from "./http-exchange.ts";

/** A file the fake daemon holds as a version of an artifact. */
export interface FakeArtifact {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/** The artifact versions of the fake daemon. See "Artifacts" in docs/protocol.md. */
export class FakeArtifacts {
  readonly #versions = new Map<string, FakeArtifact>();
  readonly #reads: string[] = [];

  /** Keeps `artifact` as a version of its own and returns the version's identifier. */
  add(artifact: FakeArtifact): string {
    const versionId = randomUUID();
    this.#versions.set(versionId, artifact);
    return versionId;
  }

  /** The identifiers of the versions that were asked for, oldest request first. */
  reads(): string[] {
    return [...this.#reads];
  }

  /** `GET /artifacts/versions/<version_id>`. */
  serve(versionId: string, response: ServerResponse): void {
    this.#reads.push(versionId);
    const artifact = this.#versions.get(versionId);
    if (artifact === undefined) {
      sendJson(response, 404, { detail: `Version ${versionId} not found` });
      return;
    }
    response
      .writeHead(200, {
        "content-type": artifact.contentType,
        "content-length": artifact.data.byteLength,
        "content-disposition": disposition(artifact.filename),
      })
      .end(artifact.data);
  }
}

/** The header that names a file, with a name that is not ASCII given a second time, encoded. */
function disposition(filename: string): string {
  const plain = filename.replace(/[^\x20-\x7e]/g, "_");
  return plain === filename
    ? `inline; filename="${plain}"`
    : `inline; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
