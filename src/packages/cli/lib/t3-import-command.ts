import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { conversationsWithoutSession } from "../../acp-agent/index.ts";
import { projectFolderNames } from "../../folder-names/index.ts";
import {
  type Conversation,
  connectScienceDaemon,
  type Project,
  type ScienceDaemon,
} from "../../science-daemon/index.ts";
import { daemonSetup } from "./daemon-setup.ts";
import { CommandError, reportFailure, UsageError } from "./failure.ts";
import { linkSubfolder } from "./link-all.ts";
import type { CommandIo } from "./run-cli.ts";
import { stateFolder } from "./state-folder.ts";
import { T3_CLI_MISSING, type T3Cli } from "./t3-cli.ts";

const USAGE = "Usage: csbridge t3-import [--provider <id>] [--prefix <text>] <folder>";

/** What the command was asked to do. */
interface ImportArguments {
  readonly folder: string;
  /** The identifier of the Claude Science provider in T3 Code's settings. */
  readonly provider: string;
  /** Put before a project's name to make the title of its T3 project. */
  readonly prefix: string;
}

/**
 * `csbridge t3-import <folder>`: brings Claude Science into T3 Code in one go. Every project
 * gets a linked sub-folder of `<folder>` and a T3 project for it, and every conversation that
 * has no thread yet gets one that opens it. Each thread shows the conversation's earlier
 * messages and settles itself, so nothing is left looking like work that has just finished.
 *
 * It can be run again at any time to bring in what is new.
 */
export async function runT3ImportCommand(args: readonly string[], io: CommandIo): Promise<number> {
  let daemon: ScienceDaemon | undefined;
  try {
    const wanted = readArguments(args);
    const t3 = t3CliOf(io);
    const parent = resolve(io.cwd, wanted.folder);
    if (!(await isFolder(parent))) {
      throw new CommandError(`${parent} is not a folder. Create it, then run the command again.`);
    }

    daemon = await connectScienceDaemon(daemonSetup(io));
    const projects = await daemon.listProjects();
    let failures = 0;
    for (const { project, folderName } of projectFolderNames(projects)) {
      const folder = join(parent, folderName);
      const title = `${wanted.prefix}${project.name}`;
      const linked = await linkSubfolder(folder, project);
      if (linked.reason !== undefined) {
        failures++;
        io.stderr.write(`${title}: skipped, ${linked.reason}\n`);
        continue;
      }
      await addProject(t3, title, folder);
      const tally = await bringIn({ t3, daemon, io, provider: wanted.provider }, project, folder);
      failures += tally.failed;
      io.stdout.write(`${title}: ${summary(tally)}\n`);
    }
    return failures === 0 ? 0 : 1;
  } catch (error) {
    return reportFailure(error, io.stderr);
  } finally {
    daemon?.close();
  }
}

interface Tally {
  broughtIn: number;
  alreadyThere: number;
  failed: number;
}

/** Starts a thread for every conversation of `project` that has none, oldest first. */
async function bringIn(
  context: {
    t3: T3Cli;
    daemon: ScienceDaemon;
    io: CommandIo;
    provider: string;
  },
  project: Project,
  folder: string,
): Promise<Tally> {
  const { t3, daemon, io } = context;
  const all = await daemon.listConversations(project.projectId);
  const unrecorded = await conversationsWithoutSession(daemon, stateFolder(io), project.projectId);
  // A thread that T3 Code imported by itself carries the conversation's identifier in its own.
  const threadIds = await existingThreadIds(t3, folder);
  const missing = unrecorded.filter(
    ({ conversationId }) => !threadIds.some((threadId) => threadId.includes(conversationId)),
  );
  const tally: Tally = { broughtIn: 0, alreadyThere: all.length - missing.length, failed: 0 };

  // Oldest first, so that the newest conversation ends up as the most recent thread.
  for (const conversation of [...missing].reverse()) {
    try {
      await t3(startThread(conversation, folder, context.provider));
      tally.broughtIn++;
    } catch (error) {
      tally.failed++;
      io.stderr.write(`Could not bring in "${conversation.title}": ${describe(error)}\n`);
    }
  }
  return tally;
}

/**
 * T3 Code's name for "whatever model the agent runs on". The thread starts on it; opening the
 * conversation then gives the thread the conversation's own model.
 */
const AGENTS_OWN_MODEL = "default";

/** The `t3` arguments that start a thread opening `conversation`. */
function startThread(conversation: Conversation, folder: string, provider: string): string[] {
  return [
    "thread",
    "start",
    "--json",
    "--wait",
    "--provider",
    provider,
    "--model",
    AGENTS_OWN_MODEL,
    "--title",
    conversation.title,
    folder,
    `/open ${conversation.conversationId}`,
  ];
}

/** Makes `folder` a T3 project. One that exists already is left as it is. */
async function addProject(t3: T3Cli, title: string, folder: string): Promise<void> {
  try {
    await t3(["project", "add", "--title", title, folder]);
  } catch (error) {
    const reason = describe(error);
    if (reason.includes("ProjectAlreadyExists")) return;
    if (reason === T3_CLI_MISSING) throw new CommandError(reason);
    throw new CommandError(`T3 Code could not add the project ${folder}: ${reason}`);
  }
}

async function existingThreadIds(t3: T3Cli, folder: string): Promise<string[]> {
  const listed: unknown = JSON.parse(await t3(["thread", "list", "--json", "--project", folder]));
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((thread: unknown) =>
    typeof thread === "object" &&
    thread !== null &&
    "threadId" in thread &&
    typeof thread.threadId === "string"
      ? [thread.threadId]
      : [],
  );
}

function summary({ broughtIn, alreadyThere, failed }: Tally): string {
  const parts = [
    ...(broughtIn > 0
      ? [`${broughtIn} ${broughtIn === 1 ? "conversation" : "conversations"} brought in`]
      : []),
    ...(alreadyThere > 0 ? [`${alreadyThere} already there`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
  ];
  return parts.length === 0 ? "nothing to bring in" : parts.join(", ");
}

function t3CliOf(io: CommandIo): T3Cli {
  if (io.t3Cli !== undefined) return io.t3Cli;
  throw new CommandError(T3_CLI_MISSING);
}

function readArguments(args: readonly string[]): ImportArguments {
  let provider = "claudeScience";
  let prefix = "CS-";
  const folders: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    if (argument === "--provider" || argument === "--prefix") {
      const value = args[++index];
      if (value === undefined) throw new UsageError(`${argument} needs a value.\n${USAGE}`);
      if (argument === "--provider") provider = value;
      else prefix = value;
    } else if (argument.startsWith("--")) {
      throw new UsageError(`Unknown option ${argument}.\n${USAGE}`);
    } else {
      folders.push(argument);
    }
  }
  const [folder, ...extra] = folders;
  if (folder === undefined || extra.length > 0) throw new UsageError(USAGE);
  return { folder, provider, prefix };
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
