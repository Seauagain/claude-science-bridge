import type { DaemonHttp } from "./http.ts";

/** A file Claude Science made and kept with a project, in one of its versions. */
export interface ArtifactFile {
  /** The file's name, as Claude Science saved it. Empty when the daemon gives none. */
  readonly filename: string;
  /** The file's media type, or an empty string when the daemon names none. */
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * The longest artifact that is fetched. A reply shows figures, which are far smaller; a file of
 * any size can be an artifact, and this one is held in memory.
 */
const MOST_BYTES = 64 * 1024 * 1024;

/**
 * Fetches the version of an artifact that `versionId` names. See "Artifacts" in
 * docs/protocol.md.
 */
export async function readArtifact(http: DaemonHttp, versionId: string): Promise<ArtifactFile> {
  const file = await http.download(
    `/artifacts/versions/${encodeURIComponent(versionId)}`,
    MOST_BYTES,
  );
  return { filename: file.filename ?? "", mimeType: file.contentType, data: file.data };
}
