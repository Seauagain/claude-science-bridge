import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReplyScript } from "../../science-daemon/testing.ts";
import { type Harness, runTurn, startHarness } from "./support/harness.ts";
import { loadSession, replyText } from "./support/loaded-session.ts";
import { shownIn } from "./support/shown-turn.ts";

let harness: Harness;
/** A folder Claude Science works in, which is not the session's folder. */
let work: string;
/** The file `analysis/reports/summary.md` in it. */
let summary: string;

beforeEach(async () => {
  harness = await startHarness();
  work = await mkdtemp(join(tmpdir(), "csbridge-work-"));
  summary = join(work, "analysis", "reports", "summary.md");
  await writeTo(summary);
});

afterEach(async () => {
  await harness.dispose();
  await rm(work, { recursive: true, force: true });
});

async function writeTo(file: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "# Summary\n", "utf8");
}

/**
 * The reply text of one turn, in the pieces the thread was sent. The session is in `folder`, or
 * in a folder of its own.
 */
async function replyPieces(script: ReplyScript, folder?: string): Promise<string[]> {
  const sessionFolder = folder ?? (await harness.linkedFolder("Protein folding")).folder;
  harness.fake.onNextMessage(script);
  const sessionId = await harness.withClient(async (context) => {
    const session = await context.buildSession(sessionFolder).start();
    await runTurn(session, "Write the summary.");
    return session.sessionId;
  });
  return shownIn(harness, sessionId).flatMap((update) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? [update.content.text]
      : [],
  );
}

/** A tool use that names `folder` the way a code tool does: inside its code. */
const worksIn = (folder: string) => ({
  name: "python",
  input: { code: `out = '${folder}'\nopen(out + '/summary.md', 'w').write(text)` },
});

/** A turn in which a tool works in the reports folder and the reply is `said`, piece by piece. */
const afterWorkingInReports =
  (...said: string[]): ReplyScript =>
  (turn) => {
    const [write] = turn.useTools([worksIn(join(work, "analysis", "reports"))]);
    write?.end("");
    for (const piece of said) turn.replyText(piece);
    turn.complete();
  };

function replyAfterWorkingInReports(...said: string[]): Promise<string[]> {
  return replyPieces(afterWorkingInReports(...said));
}

describe("a reply that names a file relative to a folder a tool worked in", () => {
  it("names the file by its full path, so that the client can open it", async () => {
    const pieces = await replyAfterWorkingInReports(
      "The summary is in `analysis/reports/summary.md`.",
    );

    expect(pieces.join("")).toBe(`The summary is in \`${summary}\`.`);
  });

  it("finds the file from any folder above the one the tool named, and by its name alone", async () => {
    const pieces = await replyAfterWorkingInReports(
      "See `reports/summary.md`, or `summary.md` for short.",
    );

    expect(pieces.join("")).toBe(`See \`${summary}\`, or \`${summary}\` for short.`);
  });

  it("finds the file from what a tool gave back", async () => {
    const pieces = await replyPieces((turn) => {
      const [list] = turn.useTools([{ name: "list_files", input: {} }]);
      list?.end(`${summary}\n`);
      turn.replyText("It is `reports/summary.md`.");
      turn.complete();
    });

    expect(pieces.join("")).toBe(`It is \`${summary}\`.`);
  });

  it("does so when the path arrives in pieces, without holding back the text before it", async () => {
    const pieces = await replyAfterWorkingInReports(
      "The summary is in `analysis/rep",
      "orts/summary.md`, as asked.",
    );

    expect(pieces[0]).toBe("The summary is in ");
    expect(pieces.join("")).toBe(`The summary is in \`${summary}\`, as asked.`);
  });
});

describe("a reply whose code spans are left as they are", () => {
  it.each([
    ["a file that is not there", "Not written yet: `analysis/reports/missing.md`."],
    ["something that is not a path", "Call `df.head()` on the `summary` table."],
    ["a full path", "It is `/nowhere/analysis/reports/summary.md`."],
    ["a code block", "```md\nSee `analysis/reports/summary.md`\n```\n"],
    ["a span that never closes", "Unfinished: `analysis/reports/summary.md"],
    ["a span that ends with its line", "Odd: `analysis/reports/summary.md\nand more` text."],
  ])("%s", async (_what, said) => {
    const pieces = await replyAfterWorkingInReports(said);

    expect(pieces.join("")).toBe(said);
  });

  it("a file that two folders the tools worked in both have", async () => {
    await writeTo(join(work, "archive", "reports", "summary.md"));

    const pieces = await replyPieces((turn) => {
      const [write] = turn.useTools([
        worksIn(join(work, "analysis", "reports")),
        worksIn(join(work, "archive", "reports")),
      ]);
      write?.end("");
      turn.replyText("See `reports/summary.md`.");
      turn.complete();
    });

    expect(pieces.join("")).toBe("See `reports/summary.md`.");
  });

  it("a file the session's own folder has, which the client finds by itself", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    await writeTo(join(folder, "reports", "summary.md"));

    const pieces = await replyPieces(afterWorkingInReports("See `reports/summary.md`."), folder);

    expect(pieces.join("")).toBe("See `reports/summary.md`.");
  });
});

describe("the history of a conversation that names a file relative to a tool's folder", () => {
  it("names the file by its full path", async () => {
    const { folder, projectId } = await harness.linkedFolder("Protein folding");
    const conversationId = harness.fake.addConversation(projectId, {
      title: "Summary of the screen",
      updatedAt: "2026-11-02T10:00:00Z",
      transcript: [
        { role: "user", content: "Write the summary." },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_write",
              name: "write_file",
              input: { file_path: summary },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_write", content: "written" }],
        },
        { role: "assistant", content: [{ type: "text", text: "Done: `reports/summary.md`." }] },
      ],
    });

    const session = await harness.withClient((context) =>
      loadSession(harness, context, conversationId, folder),
    );

    expect(session.history.at(-1)).toEqual(replyText(`Done: \`${summary}\`.`));
  });
});
