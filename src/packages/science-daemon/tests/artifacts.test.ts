import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectScienceDaemon, type ScienceDaemon } from "../index.ts";
import { type FakeScienceDaemon, startFakeScienceDaemon } from "../testing.ts";

let fake: FakeScienceDaemon;
let daemon: ScienceDaemon;

beforeEach(async () => {
  fake = await startFakeScienceDaemon();
  daemon = await connectScienceDaemon({ scienceCli: fake.scienceCli });
});

afterEach(async () => {
  daemon.close();
  await fake.close();
});

describe("fetching a version of an artifact", () => {
  it("gives the file with its name and its media type", async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const versionId = fake.addArtifact({
      filename: "spectrum.png",
      contentType: "image/png",
      data,
    });

    const file = await daemon.readArtifact(versionId);

    expect(file).toEqual({ filename: "spectrum.png", mimeType: "image/png", data });
  });

  it("gives a file name that is not ASCII as it is", async () => {
    const versionId = fake.addArtifact({
      filename: "光谱.png",
      contentType: "image/png",
      data: new Uint8Array([1]),
    });

    expect((await daemon.readArtifact(versionId)).filename).toBe("光谱.png");
  });

  it("fails as not found for a version the daemon does not have", async () => {
    await expect(daemon.readArtifact(randomUUID())).rejects.toMatchObject({ kind: "not-found" });
  });

  it("does not read a file that is longer than a figure ever is", async () => {
    const versionId = fake.addArtifact({
      filename: "trajectory.bin",
      contentType: "application/octet-stream",
      data: new Uint8Array(64 * 1024 * 1024 + 1),
    });

    await expect(daemon.readArtifact(versionId)).rejects.toMatchObject({ kind: "rejected" });
  });

  it("fetches again after the daemon stopped accepting the login", async () => {
    const data = new Uint8Array([7, 7, 7]);
    const versionId = fake.addArtifact({ filename: "fit.png", contentType: "image/png", data });
    fake.expireLogins();

    expect((await daemon.readArtifact(versionId)).data).toEqual(data);
  });
});
