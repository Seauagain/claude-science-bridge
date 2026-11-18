import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreateElicitationRequest, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelTurn, type Harness, runTurn, startHarness } from "./support/harness.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.dispose();
});

/** Picks the option with this identifier, as a user clicking it. */
const pick = (optionId: string) => () => ({ outcome: "selected" as const, optionId });

/** What a client shows of a permission request: the question and the choices. */
function shown(request: RequestPermissionRequest | undefined) {
  return {
    question: request?.toolCall.title,
    options: request?.options.map((option) => `${option.optionId}=${option.name} (${option.kind})`),
  };
}

/** The daemon stops the next turn to ask for access to a folder, then says what came of it. */
function askForFolder(mode: "ro" | "rw" = "rw") {
  harness.fake.onNextMessage(async (turn) => {
    turn.replyText("I need your data. ");
    const [answer] = await turn.ask([
      { kind: "host", target: "/data/genomes", requested_mode: mode },
    ]);
    turn.replyText(answer?.approved === true ? "Access granted." : "Access denied.");
    turn.complete();
  });
}

// The tests below run on a client that offers no forms, which gets every request as an ACP
// permission request. What a client that offers forms gets is at the end of this file.
describe("a request for access to a folder on the user's computer", () => {
  it("is shown to the user as a permission request that says what is asked", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder("rw");
    harness.answerPermissions(pick("deny"));

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Analyse my genomes");
    });

    expect(shown(harness.permissionRequests()[0])).toEqual({
      question: "Access /data/genomes on your computer (read and write)?",
      options: [
        "allow:rw=Allow read & write (allow_always)",
        "allow:ro=Allow read-only (allow_always)",
        "deny=Deny (reject_once)",
      ],
    });
  });

  it("offers read-only access alone when that is all that was asked for", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder("ro");
    harness.answerPermissions(pick("deny"));

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Analyse my genomes");
    });

    expect(shown(harness.permissionRequests()[0])).toEqual({
      question: "Access /data/genomes on your computer (read-only)?",
      options: ["allow:ro=Allow read-only (allow_always)", "deny=Deny (reject_once)"],
    });
  });

  it("carries an allow back, and the reply goes on in the same turn", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder("rw");
    harness.answerPermissions(pick("allow:ro"));

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Analyse my genomes");
    });

    expect(harness.fake.inputResponses()).toEqual([
      {
        requestId: expect.any(String),
        tool_id: expect.any(String),
        approved: true,
        action: "allow",
        mode: "ro",
        scope: "always",
      },
    ]);
    expect(chunks.join("")).toBe("I need your data. Access granted.");
    expect(stopReason).toBe("end_turn");
  });

  it("carries a deny back", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    harness.answerPermissions(pick("deny"));

    const { chunks } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Analyse my genomes");
    });

    expect(harness.fake.inputResponses()).toEqual([
      {
        requestId: expect.any(String),
        tool_id: expect.any(String),
        approved: false,
        action: "deny",
      },
    ]);
    expect(chunks.join("")).toBe("I need your data. Access denied.");
  });

  it("shows up in the thread as a tool call that ends as completed or failed", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    harness.answerPermissions(pick("deny"));

    const updates = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Analyse my genomes");
      return harness.updates(session.sessionId);
    });

    const toolCalls = updates.flatMap((update) =>
      update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
        ? [{ update: update.sessionUpdate, title: update.title, status: update.status }]
        : [],
    );
    expect(toolCalls).toEqual([
      {
        update: "tool_call",
        title: "Access /data/genomes on your computer (read and write)?",
        status: "pending",
      },
      { update: "tool_call_update", title: undefined, status: "failed" },
    ]);
  });
});

describe("a request the user leaves unanswered", () => {
  it("ends the prompt as cancelled and sends the daemon no answer", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    harness.answerPermissions(() => ({ outcome: "cancelled" }));

    const { stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Analyse my genomes");
    });

    expect(stopReason).toBe("cancelled");
    expect(harness.fake.inputResponses()).toEqual([]);
  });

  it("is shown again when the next prompt arrives, which is then sent after the answer", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    let decision: () => { outcome: "cancelled" } | { outcome: "selected"; optionId: string } =
      () => ({ outcome: "cancelled" });
    harness.answerPermissions(() => decision());

    const second = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Analyse my genomes");
      decision = pick("allow:rw");
      return runTurn(session, "Are you there?");
    });

    // The daemon refuses a message while a request is pending, so the request comes first.
    expect(harness.permissionRequests()).toHaveLength(2);
    expect(harness.fake.inputResponses()).toHaveLength(1);
    // The rest of the turn that had asked, then the reply to the new message.
    expect(second.chunks.join("")).toBe("Access granted.\n\npong");
    expect(second.stopReason).toBe("end_turn");
    expect(harness.fake.conversations()[0]?.messages).toEqual([
      "Analyse my genomes",
      "Are you there?",
    ]);
  });

  it("is dropped with the turn when the user stops the reply while it is shown", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();

    const { stopReason, conversationId } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      // The client answers a permission request it has open as cancelled when its user stops
      // the turn, which it tells the agent with a cancel notification.
      harness.answerPermissions(async () => {
        await cancelTurn(context, session);
        return { outcome: "cancelled" };
      });
      const turn = await runTurn(session, "Analyse my genomes");
      return { ...turn, conversationId: session.sessionId };
    });

    expect(stopReason).toBe("cancelled");
    expect(conversationId).toEqual(expect.any(String));
    expect(harness.fake.cancelRequests()).toHaveLength(1);
    expect(harness.fake.inputResponses()).toEqual([]);
  });
});

describe("an approval that the daemon remembers for a scope", () => {
  function askForConnector() {
    harness.fake.onNextMessage(async (turn) => {
      const [answer] = await turn.ask([
        { kind: "mcp_tool", server_name: "PubMed", tool_name: "search_articles" },
      ]);
      turn.replyText(`scope: ${String(answer?.scope)}`);
      turn.complete();
    });
  }

  it("offers once and the scope Claude Science itself suggests", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForConnector();
    harness.answerPermissions(pick("deny"));

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Search the literature");
    });

    expect(shown(harness.permissionRequests()[0])).toEqual({
      question: "Use the connector tool PubMed: search_articles?",
      options: [
        "allow:once=Allow once (allow_once)",
        "allow:project=Allow for this project (allow_always)",
        "deny=Deny (reject_once)",
      ],
    });
  });

  it("allows once without naming a scope, as the daemon wants it", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForConnector();
    harness.answerPermissions(pick("allow:once"));

    const { chunks } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Search the literature");
    });

    expect(harness.fake.inputResponses()[0]).toEqual({
      requestId: expect.any(String),
      tool_id: expect.any(String),
      approved: true,
      action: "allow",
    });
    expect(chunks.join("")).toBe("scope: undefined");
  });

  it("names the scope of a lasting approval", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForConnector();
    harness.answerPermissions(pick("allow:project"));

    const { chunks } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Search the literature");
    });

    expect(chunks.join("")).toBe("scope: project");
  });
});

describe("a question with choices", () => {
  function askWhichOrganism() {
    harness.fake.onNextMessage(async (turn) => {
      const [answer] = await turn.ask([
        {
          kind: "ask",
          questions: [
            {
              question: "Which organism?",
              header: "Organism",
              options: [{ label: "Human" }, { label: "Mouse", description: "Mus musculus" }],
            },
          ],
        },
      ]);
      turn.replyText(JSON.stringify({ action: answer?.action, answers: answer?.answers }));
      turn.complete();
    });
  }

  it("is shown with its choices and a way to skip it", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askWhichOrganism();
    harness.answerPermissions(pick("skip"));

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Align the reads");
    });

    expect(shown(harness.permissionRequests()[0])).toEqual({
      question: "Which organism?",
      options: [
        "answer:0=Human (allow_once)",
        "answer:1=Mouse (allow_once)",
        "skip=Skip (reject_once)",
      ],
    });
  });

  it("carries the chosen answer back under the question", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askWhichOrganism();
    harness.answerPermissions(pick("answer:1"));

    const { chunks } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Align the reads");
    });

    expect(JSON.parse(chunks.join(""))).toEqual({
      action: "answer",
      answers: { "Which organism?": "Mouse" },
    });
  });

  it("tells the daemon when the user skips it", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askWhichOrganism();
    harness.answerPermissions(pick("skip"));

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Align the reads");
    });

    expect(harness.fake.inputResponses()[0]).toEqual({
      requestId: expect.any(String),
      tool_id: expect.any(String),
      approved: false,
      action: "cancel",
    });
  });
});

describe("several requests at once", () => {
  it("are asked one after the other and answered together", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      const answers = await turn.ask([
        { kind: "host", target: "/data/genomes", requested_mode: "ro" },
        { kind: "network", target: "ncbi.nlm.nih.gov" },
      ]);
      turn.replyText(answers.map((answer) => answer.action).join(","));
      turn.complete();
    });
    harness.answerPermissions((request) =>
      request.toolCall.title?.startsWith("Access")
        ? { outcome: "selected", optionId: "allow:ro" }
        : { outcome: "selected", optionId: "deny" },
    );

    const { chunks } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Analyse my genomes");
    });

    expect(harness.permissionRequests().map((request) => request.toolCall.title)).toEqual([
      "Access /data/genomes on your computer (read-only)?",
      "Allow network access to ncbi.nlm.nih.gov?",
    ]);
    expect(chunks.join("")).toBe("allow,deny");
  });
});

describe("a request this client cannot answer", () => {
  it("is described in the thread, and the reply goes on once it is answered in Claude Science", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      await turn.ask([{ kind: "credential_request", label: "OpenAlex" }]);
      turn.replyText("Thanks.");
      turn.complete();
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Search OpenAlex", (chunk) => {
        if (chunk.includes("Claude Science")) harness.fake.answerInBrowser(true);
      });
    });

    expect(harness.permissionRequests()).toEqual([]);
    expect(chunks[0]).toMatch(/waiting.*credential.*answer it in Claude Science/is);
    expect(chunks.at(-1)).toBe("Thanks.");
    expect(stopReason).toBe("end_turn");
  });
});

describe("a request for a contact email address", () => {
  const NOTICE =
    "Some research data services ask for a contact email.\n\nIf you decline, none is sent.";

  /** The daemon asks for a contact email address, then says what came of it. */
  function askForEmail(also: readonly Record<string, unknown>[] = []) {
    harness.fake.onNextMessage(async (turn) => {
      turn.replyText("Looking up the paper. ");
      const [answer] = await turn.ask([
        { kind: "contact_email", notice_text: NOTICE, notice_version: "v1" },
        ...also,
      ]);
      turn.replyText(answer?.approved === true ? `Using ${String(answer.text)}.` : "No email.");
      turn.complete();
    });
  }

  it("is put in the thread with the daemon's notice, and ends the prompt until the user answers", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmail();

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Find the paper");
    });

    expect(chunks.join("")).toBe(
      "Looking up the paper. " +
        `**Claude Science asks for a contact email address.**\n\n${NOTICE}\n\n` +
        "Send the address as your next message, or send `decline` to share none and not be " +
        "asked again, or `skip` to decide later.\n\n",
    );
    expect(stopReason).toBe("end_turn");
    expect(harness.permissionRequests()).toEqual([]);
    expect(harness.fake.inputResponses()).toEqual([]);
  });

  it("takes the next message as the address, and does not send it as a message", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmail();

    const second = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Find the paper");
      return runTurn(session, " ada@example.org ");
    });

    expect(harness.fake.inputResponses()).toMatchObject([
      { approved: true, action: "allow", text: "ada@example.org" },
    ]);
    expect(harness.fake.inputResponses()[0]).not.toHaveProperty("scope");
    // The rest of the turn that had asked, and nothing after it.
    expect(second.chunks.join("")).toBe("Using ada@example.org.");
    expect(second.stopReason).toBe("end_turn");
    expect(harness.fake.conversations()[0]?.messages).toEqual(["Find the paper"]);
  });

  it("leaves out what the client adds to a prompt after the user's own words", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmail();

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Find the paper");
      return session.prompt([
        { type: "text", text: "ada@example.org" },
        { type: "text", text: "<runtime_info>In T3 Code.</runtime_info>" },
      ]);
    });

    expect(harness.fake.inputResponses()).toMatchObject([
      { action: "allow", text: "ada@example.org" },
    ]);
  });

  it.each([
    ["decline", { approved: false, action: "deny" }],
    ["Skip", { approved: false, action: "cancel" }],
  ])("takes the word %s as the answer it stands for", async (word, response) => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmail();

    const second = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Find the paper");
      return runTurn(session, word);
    });

    expect(harness.fake.inputResponses()).toMatchObject([response]);
    expect(second.chunks.join("")).toBe("No email.");
    expect(harness.fake.conversations()[0]?.messages).toEqual(["Find the paper"]);
  });

  it("asks again for a message that is no address, and sends the daemon nothing", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmail();

    const second = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Find the paper");
      return runTurn(session, "why do you need it?");
    });

    expect(second.chunks.join("")).toBe(
      "That is not what Claude Science asked for. Send the address as your next message, " +
        "or send `decline` to share none and not be asked again, or `skip` to decide later.\n\n",
    );
    expect(second.stopReason).toBe("end_turn");
    expect(harness.fake.inputResponses()).toEqual([]);
    expect(harness.fake.conversations()[0]?.messages).toEqual(["Find the paper"]);
  });

  it("is settled before a request with choices of the same turn, and both are answered together", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmail([{ kind: "host", target: "/data/genomes", requested_mode: "ro" }]);
    harness.answerPermissions(pick("allow:ro"));

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Find the paper");
      // Nothing is asked with buttons while the address is still to come.
      expect(harness.permissionRequests()).toEqual([]);
      return runTurn(session, "ada@example.org");
    });

    expect(harness.permissionRequests()).toHaveLength(1);
    expect(harness.fake.inputResponses()).toMatchObject([
      { action: "allow", text: "ada@example.org" },
      { action: "allow", mode: "ro" },
    ]);
  });

  it("sends a later message as a message again", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmail();

    const third = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Find the paper");
      await runTurn(session, "ada@example.org");
      return runTurn(session, "Are you there?");
    });

    expect(third.chunks.join("")).toBe("pong");
    expect(harness.fake.conversations()[0]?.messages).toEqual(["Find the paper", "Are you there?"]);
  });
});

describe("what the question says about a request for folder access", () => {
  it("names the access the folder has already and the path that was asked for", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    harness.fake.onNextMessage(async (turn) => {
      await turn.ask([
        {
          kind: "host",
          target: "/data",
          requested_path: "/data/genomes/hg38.fa",
          requested_mode: "rw",
          existing_mode: "ro",
        },
      ]);
      turn.complete();
    });
    harness.answerPermissions(pick("deny"));

    await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Analyse my genomes");
    });

    expect(harness.permissionRequests()[0]?.toolCall.title).toBe(
      "Access /data on your computer (read and write)? " +
        "It is asked for /data/genomes/hg38.fa. The folder has read-only access now.",
    );
  });
});

describe("a question that lets several choices be picked", () => {
  /** The daemon asks which organisms, then says what it was told. */
  function askWhichOrganisms() {
    harness.fake.onNextMessage(async (turn) => {
      const [answer] = await turn.ask([
        {
          kind: "ask",
          questions: [
            {
              question: "Which organisms?",
              options: [{ label: "Human" }, { label: "Mouse" }, { label: "Zebrafish" }],
              multi_select: true,
            },
          ],
        },
      ]);
      turn.replyText(answer?.approved === true ? "Aligning." : "No organisms.");
      turn.complete();
    });
  }

  it("is put in the thread with its options, to be answered by the next message", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askWhichOrganisms();

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Align the reads");
    });

    expect(harness.permissionRequests()).toEqual([]);
    expect(chunks.join("")).toBe(
      "**Which organisms?**\n\n" +
        "Name one or more of these, separated by commas, or answer in your own words:\n" +
        "- Human\n- Mouse\n- Zebrafish\n\n" +
        "Send your answer as your next message, or send `skip` to skip the question.\n\n",
    );
    expect(stopReason).toBe("end_turn");
    expect(harness.fake.inputResponses()).toEqual([]);
  });

  it("carries the next message back as the answer, under the question", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askWhichOrganisms();

    const second = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Align the reads");
      return runTurn(session, "Human, Mouse");
    });

    expect(harness.fake.inputResponses()).toMatchObject([
      { approved: true, action: "answer", answers: { "Which organisms?": "Human, Mouse" } },
    ]);
    expect(second.chunks.join("")).toBe("Aligning.");
  });
});

describe("a request that was answered in Claude Science while the client was asking", () => {
  it("says that the choice made in the client was not applied", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    harness.answerPermissions(() => {
      // The user says no in the browser, and then clicks yes in the client.
      harness.fake.answerInBrowser(false);
      return { outcome: "selected", optionId: "allow:rw" };
    });

    const { chunks, stopReason } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      return runTurn(session, "Analyse my genomes");
    });

    expect(harness.fake.inputResponses()).toEqual([
      expect.objectContaining({ approved: false, action: "deny" }),
    ]);
    expect(chunks.join("")).toMatch(
      /already answered in Claude Science.*not applied.*Access denied\./s,
    );
    expect(stopReason).toBe("end_turn");
  });
});

describe("requests the daemon lists for a conversation that is not waiting", () => {
  it("are left alone: the list of a turn that has ended is out of date", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");

    const { chunks } = await harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Analyse my genomes");
      const [conversation] = harness.fake.conversations();
      expect(conversation?.status).toBe("completed");
      const conversationId = await conversationOf(session.sessionId);
      harness.fake.respondOnce(`GET /api/frames/${conversationId}`, {
        id: conversationId,
        status: "completed",
        agent_name: "OPERON",
        output_data: {
          pending_input_requests: [
            { requestId: "stale", kind: "host", target: "/data/genomes", requested_mode: "rw" },
          ],
        },
      });
      return runTurn(session, "Are you there?");
    });

    expect(chunks.join("")).toBe("pong");
  });
});

describe("a message the daemon refuses because it waits for an answer csbridge did not find", () => {
  it("fails with what to do about it", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    harness.answerPermissions(() => ({ outcome: "cancelled" }));

    const failure = harness.withClient(async (context) => {
      const session = await context.buildSession(folder).start();
      await runTurn(session, "Analyse my genomes");
      // The request is one the frame does not list, as one of a sub-agent may be.
      const conversationId = await conversationOf(session.sessionId);
      harness.fake.respondOnce(`GET /api/frames/${conversationId}`, {
        id: conversationId,
        status: "awaiting_user_response",
        agent_name: "OPERON",
      });
      return runTurn(session, "Are you there?");
    });

    await expect(failure).rejects.toThrow(
      /waiting for an answer.*Answer it in Claude Science, then send your message again/s,
    );
  });
});

/** The conversation a session of the harness's clients belongs to, from the adapter's record. */
async function conversationOf(sessionId: string): Promise<string> {
  const record = await readFile(join(harness.stateFolder, "sessions.jsonl"), "utf8");
  for (const line of record.split("\n").filter(Boolean)) {
    const pair = JSON.parse(line) as { sessionId: string; conversationId: string };
    if (pair.sessionId === sessionId) return pair.conversationId;
  }
  throw new Error(`no conversation on record for session ${sessionId}`);
}

/** What a client shows of a form: the question and the choices. */
function formShown(form: CreateElicitationRequest | undefined) {
  // The SDK types a form's schema loosely, so it is read as the JSON it is.
  const { requestedSchema: schema = {} } = JSON.parse(JSON.stringify(form ?? {})) as {
    requestedSchema?: {
      properties?: Record<string, { oneOf?: { const: string; title: string }[] }>;
      required?: string[];
    };
  };
  const [[field, property] = []] = Object.entries(schema.properties ?? {});
  return {
    mode: form?.mode,
    message: form?.message,
    field,
    required: schema.required,
    choices: property?.oneOf?.map((choice) => `${choice.const}=${choice.title}`),
  };
}

// A client decides permission requests by rules of its own, and may answer them without
// showing them: T3 Code allows every one in its Auto and Full access modes, and has three
// fixed buttons for the rest. What Claude Science asks is the user's to answer, with the
// choices Claude Science gives, so a client that offers forms is asked with a form.
describe("in a client that can put forms to its user", () => {
  it("a request is put as a form with the request's own choices, not as a permission request", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder("rw");
    harness.answerForms(() => ({ action: "accept", content: { answer: "allow:ro" } }));

    const { chunks, stopReason } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Analyse my genomes");
      },
      { forms: true },
    );

    expect(harness.permissionRequests()).toEqual([]);
    expect(formShown(harness.forms()[0])).toEqual({
      mode: "form",
      message: "Access /data/genomes on your computer (read and write)?",
      field: "answer",
      required: ["answer"],
      choices: ["allow:rw=Allow read & write", "allow:ro=Allow read-only", "deny=Deny"],
    });
    expect(harness.fake.inputResponses()).toEqual([
      expect.objectContaining({ approved: true, action: "allow", mode: "ro" }),
    ]);
    expect(chunks.join("")).toBe("I need your data. Access granted.");
    expect(stopReason).toBe("end_turn");
  });

  it("a declined form is the request's own way of saying no", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    harness.answerForms(() => ({ action: "decline" }));

    const { chunks } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Analyse my genomes");
      },
      { forms: true },
    );

    expect(harness.fake.inputResponses()).toEqual([
      expect.objectContaining({ approved: false, action: "deny" }),
    ]);
    expect(chunks.join("")).toBe("I need your data. Access denied.");
  });

  it("a form the user closes leaves the request unanswered and ends the prompt as cancelled", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    harness.answerForms(() => ({ action: "cancel" }));

    const { stopReason } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Analyse my genomes");
      },
      { forms: true },
    );

    expect(stopReason).toBe("cancelled");
    expect(harness.fake.inputResponses()).toEqual([]);
  });

  it("an answer that is none of the choices leaves the request unanswered", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForFolder();
    harness.answerForms(() => ({ action: "accept", content: { answer: "allow:everything" } }));

    const { stopReason } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Analyse my genomes");
      },
      { forms: true },
    );

    expect(stopReason).toBe("cancelled");
    expect(harness.fake.inputResponses()).toEqual([]);
  });
  /** The daemon asks for a contact email address, then says what came of it. */
  function askForEmailInAForm() {
    harness.fake.onNextMessage(async (turn) => {
      const [answer] = await turn.ask([
        {
          kind: "contact_email",
          notice_text: "What the address is used for.",
          notice_version: "v1",
        },
      ]);
      turn.replyText(answer?.approved === true ? `Using ${String(answer.text)}.` : "No email.");
      turn.complete();
    });
  }

  /** What a form with a field to type in shows: the question and that the field takes text. */
  function textFormShown(form: CreateElicitationRequest | undefined) {
    // The SDK types a form's schema loosely, so it is read as the JSON it is.
    const { requestedSchema: schema = {} } = JSON.parse(JSON.stringify(form ?? {})) as {
      requestedSchema?: {
        properties?: Record<string, { type?: string; oneOf?: unknown; description?: string }>;
      };
    };
    const field = schema.properties?.answer;
    return {
      message: form?.message,
      type: field?.type,
      choices: field?.oneOf,
      description: field?.description,
    };
  }

  it("a request for something to type is put as a form with a field to type in", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmailInAForm();
    harness.answerForms(() => ({ action: "accept", content: { answer: " ada@example.org " } }));

    const { chunks, stopReason } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Find the paper");
      },
      { forms: true },
    );

    expect(textFormShown(harness.forms()[0])).toEqual({
      message: "Claude Science asks for a contact email address.",
      type: "string",
      choices: undefined,
      description:
        "Claude Science asks for a contact email address. Type the address, or `decline` to " +
        "share none and not be asked again, or `skip` to decide later.",
    });
    expect(harness.fake.inputResponses()).toMatchObject([
      { approved: true, action: "allow", text: "ada@example.org" },
    ]);
    // The daemon's notice is in the thread, and the reply goes on in the same turn.
    expect(chunks.join("")).toBe(
      "**Claude Science asks for a contact email address.**\n\n" +
        "What the address is used for.\n\nUsing ada@example.org.",
    );
    expect(stopReason).toBe("end_turn");
  });

  it("a word typed into the field is the answer it stands for", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmailInAForm();
    harness.answerForms(() => ({ action: "accept", content: { answer: "decline" } }));

    await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Find the paper");
      },
      { forms: true },
    );

    expect(harness.fake.inputResponses()).toMatchObject([{ approved: false, action: "deny" }]);
  });

  it("the form comes again when what was typed is no answer", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmailInAForm();
    const typed = ["ada at example", "ada@example.org"];
    harness.answerForms(() => ({ action: "accept", content: { answer: typed.shift() } }));

    await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Find the paper");
      },
      { forms: true },
    );

    expect(harness.forms()).toHaveLength(2);
    expect(textFormShown(harness.forms()[1]).description).toMatch(
      /^That is not what Claude Science asked for\. Claude Science asks for a contact email/,
    );
    expect(harness.fake.inputResponses()).toMatchObject([{ text: "ada@example.org" }]);
  });

  it("a declined form for something to type decides nothing for good", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmailInAForm();
    harness.answerForms(() => ({ action: "decline" }));

    await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Find the paper");
      },
      { forms: true },
    );

    // Not "deny", which the daemon remembers as never to ask again.
    expect(harness.fake.inputResponses()).toMatchObject([{ approved: false, action: "cancel" }]);
  });

  it("a closed form for something to type leaves the request unanswered", async () => {
    const { folder } = await harness.linkedFolder("Protein folding");
    askForEmailInAForm();
    harness.answerForms(() => ({ action: "cancel" }));

    const { stopReason } = await harness.withClient(
      async (context) => {
        const session = await context.buildSession(folder).start();
        return runTurn(session, "Find the paper");
      },
      { forms: true },
    );

    expect(stopReason).toBe("cancelled");
    expect(harness.fake.inputResponses()).toEqual([]);
  });
});
