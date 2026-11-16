import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./support/harness.ts";
import { loadSession } from "./support/loaded-session.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

const PIXELS = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** The reference the fake daemon's `number`th attachment has in a message. */
function reference(number: number, filename: string, contentType: string, size: number): string {
  return JSON.stringify({
    type: "attachment",
    id: `attachment-${number}`,
    version_id: `version-${number}`,
    filename,
    artifact_ref: `{{artifact:version-${number}}}`,
    content_type: contentType,
    size_bytes: size,
  });
}

/** What the fake daemon was handed, with each file's bytes as text. */
function uploads() {
  return harness.fake.attachments().map(({ projectId, filename, contentType, data }) => ({
    projectId,
    filename,
    contentType,
    text: Buffer.from(data).toString("latin1"),
  }));
}

describe("attaching files to a prompt", () => {
  it("hands an image to the session's project and names it in front of the message", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt([
        { type: "text", text: "What does this gel show?" },
        { type: "image", data: PIXELS.toString("base64"), mimeType: "image/png" },
      ]);
    });

    expect(uploads()).toEqual([
      {
        projectId,
        filename: "image-1.png",
        contentType: "image/png",
        text: PIXELS.toString("latin1"),
      },
    ]);
    expect(harness.fake.conversations()[0]?.messages).toEqual([
      `${reference(1, "image-1.png", "image/png", PIXELS.length)}\nWhat does this gel show?`,
    ]);
  });

  it("sends a prompt that is nothing but an image", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt({
        type: "image",
        data: PIXELS.toString("base64"),
        mimeType: "image/jpeg",
        uri: "file:///scans/western%20blot.jpg",
      });
    });

    expect(harness.fake.conversations()[0]?.messages).toEqual([
      reference(1, "western blot.jpg", "image/jpeg", PIXELS.length),
    ]);
  });

  it("sends a file the client saved on this computer and named in the text", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const saved = join(await harness.temporaryFolder(), "0f3a-screen.csv");
    await writeFile(saved, "well,signal\nA1,0.82\n");

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt([
        {
          type: "text",
          text: `Which well is brightest?\n\n[Attached file "screen.csv" is saved at: ${saved}]`,
        },
        { type: "text", text: "<runtime_info>In T3 Code.</runtime_info>" },
      ]);
    });

    expect(uploads()).toEqual([
      {
        projectId,
        filename: "screen.csv",
        contentType: "text/csv",
        text: "well,signal\nA1,0.82\n",
      },
    ]);
    expect(harness.fake.conversations()[0]?.messages).toEqual([
      `${reference(1, "screen.csv", "text/csv", 20)}\n` +
        "Which well is brightest?\n<runtime_info>In T3 Code.</runtime_info>",
    ]);
  });

  it("sends a saved image once when the client also sends it as an image", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const saved = join(await harness.temporaryFolder(), "7c1d-gel.png");
    await writeFile(saved, PIXELS);

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt([
        {
          type: "text",
          text: `[Attached image "gel.png" is saved at: ${saved} (text extracted to: ${saved}.txt)]`,
        },
        { type: "image", data: PIXELS.toString("base64"), mimeType: "image/png" },
      ]);
    });

    expect(uploads().map(({ filename }) => filename)).toEqual(["gel.png"]);
    expect(harness.fake.conversations()[0]?.messages).toEqual([
      reference(1, "gel.png", "image/png", PIXELS.length),
    ]);
  });

  it("leaves a line that names a file it cannot read as it is", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    const line = '[Attached file "gone.csv" is saved at: /nowhere/at/all/gone.csv]';

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt(`Summarise it.\n\n${line}`);
    });

    expect(uploads()).toEqual([]);
    expect(harness.fake.conversations()[0]?.messages).toEqual([`Summarise it.\n\n${line}`]);
  });

  it("sends an embedded resource as a file, text or bytes", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt([
        { type: "text", text: "Compare these." },
        {
          type: "resource",
          resource: {
            uri: "file:///data/notes.txt",
            mimeType: "text/plain",
            text: "eleven strands",
          },
        },
        { type: "resource", resource: { uri: "file:///data/raw.bin", blob: "AAEC" } },
      ]);
    });

    expect(
      uploads().map(({ filename, contentType, text }) => [filename, contentType, text]),
    ).toEqual([
      ["notes.txt", "text/plain", "eleven strands"],
      ["raw.bin", "application/octet-stream", "\u0000\u0001\u0002"],
    ]);
  });

  it("hands the files of a later prompt to the conversation's own project", async () => {
    const { projectId } = await harness.linkedFolder("Protein folding");
    const conversationId = harness.fake.addConversation(projectId, {
      title: "Fold of GFP",
      updatedAt: "2026-11-02T10:00:00Z",
    });
    // Loaded in a folder that is not linked to the conversation's project.
    const elsewhere = await harness.unlinkedFolder();

    await harness.withClient(async (context) => {
      const { sessionId } = await loadSession(harness, context, conversationId, elsewhere);
      return context.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "And this one?" },
          { type: "image", data: PIXELS.toString("base64"), mimeType: "image/png" },
        ],
      });
    });

    expect(uploads().map((upload) => upload.projectId)).toEqual([projectId]);
    expect(harness.fake.conversations()[0]?.messages).toEqual([
      `${reference(1, "image-1.png", "image/png", PIXELS.length)}\nAnd this one?`,
    ]);
  });

  it("reports a file the daemon refuses and starts no conversation", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return session.prompt([
        { type: "text", text: "Read this." },
        { type: "resource", resource: { uri: "file:///data/empty.txt", text: "" } },
      ]);
    });

    await expect(failure).rejects.toThrow(/Claude Science refused .*Cannot upload empty file/);
    expect(harness.fake.conversations()).toEqual([]);
  });
});

describe("a conversation with attachments, read back", () => {
  it("shows each attachment as its file name and leaves out the daemon's notes about it", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const conversationId = harness.fake.addConversation(projectId, {
      title: "Gel",
      updatedAt: "2026-11-02T10:00:00Z",
      transcript: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${reference(1, "gel.png", "image/png", 8)} ${reference(2, "screen.csv", "text/csv", 20)}\nWhat do these show?`,
            },
            {
              type: "text",
              text: '[System] Attachment available: screen.csv. Use read_file(version_id="version-2") to read it.',
            },
            { type: "text", text: "[System] Attached file: gel.png" },
            { type: "image", source: { type: "_disk_ref", path: "/somewhere/gel.png" } },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "Two bands." }] },
      ],
    });

    const { chunks } = await harness.withClient(async (context) => {
      const session = await loadSession(harness, context, conversationId, folder);
      return session.runTurn("/history");
    });

    expect(chunks.join("")).toBe(
      [
        "**You**",
        "[Attached: gel.png] [Attached: screen.csv]\nWhat do these show?",
        "**Claude Science**",
        "Two bands.",
        "",
      ].join("\n\n"),
    );
  });
});
