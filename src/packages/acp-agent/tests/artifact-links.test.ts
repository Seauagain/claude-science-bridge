import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";
import { loadSession, replyText, userText } from "./support/loaded-session.ts";

/** What a figure holds: the start of a PNG file. */
const FIGURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** Has Claude Science keep a figure under `filename` and returns the version's identifier. */
function keepFigure(filename = "phase-diagram.png"): string {
  return harness.fake.addArtifact({ filename, contentType: "image/png", data: FIGURE });
}

/** Where csbridge saves the file of an artifact version. */
function savedAt(versionId: string, filename = "phase-diagram.png"): string {
  return join(harness.stateFolder, "artifacts", versionId, filename);
}

/** The reply text of one turn whose reply is `said`, in the pieces the thread was sent. */
async function replyPieces(...said: string[]): Promise<string[]> {
  const { folder } = await harness.linkedFolder("Phase behaviour");
  harness.fake.onNextMessage((turn) => {
    for (const piece of said) turn.replyText(piece);
    turn.complete();
  });
  return harness.withClient(async (context) => {
    const session = await context.buildSession(folder).start();
    return (await runTurn(session, "Plot the phase diagram.")).chunks;
  });
}

describe("a reply that shows a figure Claude Science made", () => {
  it("points the image at a file on this computer that holds the figure", async () => {
    const figure = keepFigure();

    const pieces = await replyPieces(
      `Two phases:\n\n![Phase diagram]({{artifact:${figure}}})\n\nThey meet at 300 K.`,
    );

    expect(pieces.join("")).toBe(
      `Two phases:\n\n![Phase diagram](${savedAt(figure)})\n\nThey meet at 300 K.`,
    );
    expect(new Uint8Array(await readFile(savedAt(figure)))).toEqual(FIGURE);
  });

  it("does so when the marker arrives in pieces, and holds back only the image", async () => {
    const figure = keepFigure();

    const pieces = await replyPieces(
      "The plot ![Phase diagram]",
      `({{artifact:${figure.slice(0, 8)}`,
      `${figure.slice(8)}}})`,
      " shows two phases.",
    );

    expect(pieces[0]).toBe("The plot ![Phase diagram");
    expect(pieces.join("")).toBe(`The plot ![Phase diagram](${savedAt(figure)}) shows two phases.`);
  });

  it("links a file that is not shown as an image in the same way", async () => {
    const table = harness.fake.addArtifact({
      filename: "boundaries.csv",
      contentType: "text/csv",
      data: new TextEncoder().encode("temperature,pressure\n300,1\n"),
    });

    const pieces = await replyPieces(`The table is [here]({{artifact:${table}}}).`);

    expect(pieces.join("")).toBe(`The table is [here](${savedAt(table, "boundaries.csv")}).`);
    expect(await readFile(savedAt(table, "boundaries.csv"), "utf8")).toContain("300,1");
  });

  it("keeps a file name that is not ASCII, in pointed brackets when it holds a space", async () => {
    const figure = keepFigure("相图 终稿.png");

    const pieces = await replyPieces(`![Phase diagram]({{artifact:${figure}}})`);

    expect(pieces.join("")).toBe(`![Phase diagram](<${savedAt(figure, "相图 终稿.png")}>)`);
    expect(new Uint8Array(await readFile(savedAt(figure, "相图 终稿.png")))).toEqual(FIGURE);
  });

  it("saves a file under its own name only, whatever folders the name is given with", async () => {
    const figure = keepFigure("../../outside/phase-diagram.png");

    const pieces = await replyPieces(`![Phase diagram]({{artifact:${figure}}})`);

    expect(pieces.join("")).toBe(`![Phase diagram](${savedAt(figure)})`);
  });

  it("gives a file a name when its own would hide it", async () => {
    const figure = keepFigure(".png");

    const pieces = await replyPieces(`![Phase diagram]({{artifact:${figure}}})`);

    expect(pieces.join("")).toBe(`![Phase diagram](${savedAt(figure, "artifact")})`);
  });

  it("fetches a figure once, however often and by however many adapters it is shown", async () => {
    const figure = keepFigure();
    const shown = `![Phase diagram]({{artifact:${figure}}})`;

    await replyPieces(`${shown}\n\nAnd once more:\n\n${shown}`);
    const again = await replyPieces(shown);

    expect(again.join("")).toBe(`![Phase diagram](${savedAt(figure)})`);
    expect(harness.fake.artifactReads()).toEqual([figure]);
  });

  it("leaves the marker as written when Claude Science has no such version", async () => {
    const shown = `![Phase diagram]({{artifact:${randomUUID()}}})`;

    const pieces = await replyPieces(`${shown}\n\nThey meet at 300 K.`);

    expect(pieces.join("")).toBe(`${shown}\n\nThey meet at 300 K.`);
  });

  it("leaves a marker alone that is not the destination of a link", async () => {
    const figure = keepFigure();
    const said = `Read it with \`open("{{artifact:${figure}}}")\`, or see {{artifact:${figure}}}.`;

    const pieces = await replyPieces(said);

    expect(pieces.join("")).toBe(said);
    expect(harness.fake.artifactReads()).toEqual([]);
  });

  it("passes text that only begins like such a link, as it is written", async () => {
    const pieces = await replyPieces("See [1]", "(above) and [2](", "{{artifact", " is a marker.");

    expect(pieces.join("")).toBe("See [1](above) and [2]({{artifact is a marker.");
  });

  it("passes a reply that ends in the middle of such a link, as it is written", async () => {
    const pieces = await replyPieces("The plot ![Phase diagram]({{artifact:abc");

    expect(pieces.join("")).toBe("The plot ![Phase diagram]({{artifact:abc");
  });
});

describe("the history of a conversation that showed a figure", () => {
  it("is replayed with the image pointing at the figure's file", async () => {
    const figure = keepFigure();
    const { folder, projectId } = await harness.linkedFolder("Phase behaviour");
    const conversationId = harness.fake.addConversation(projectId, {
      title: "Phase diagram",
      updatedAt: "2026-11-02T10:00:00Z",
      transcript: [
        { role: "user", content: "Plot the phase diagram." },
        {
          role: "assistant",
          content: [{ type: "text", text: `![Phase diagram]({{artifact:${figure}}})` }],
        },
      ],
    });

    const session = await harness.withClient((context) =>
      loadSession(harness, context, conversationId, folder),
    );

    expect(session.history).toEqual([
      userText("Plot the phase diagram."),
      replyText(`![Phase diagram](${savedAt(figure)})`),
    ]);
    expect(new Uint8Array(await readFile(savedAt(figure)))).toEqual(FIGURE);
  });
});
