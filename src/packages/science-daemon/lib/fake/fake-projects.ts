import { randomBytes } from "node:crypto";
import { isRecord, type JsonRecord } from "../validate.ts";
import { type Answer, undocumented } from "./http-exchange.ts";
import { TIMESTAMP } from "./stored-conversation.ts";

/** What the fake daemon holds about one project. */
export interface FakeProject {
  readonly projectId: string;
  readonly name: string;
  readonly archived: boolean;
}

/** The fake daemon's projects: `GET /projects` and `POST /projects` of docs/protocol.md. */
export class FakeProjects {
  readonly #projects: FakeProject[] = [];

  /** Creates a project and returns its identifier. Names need not be unique. */
  add(name: string, archived: boolean): string {
    const projectId = `proj_${randomBytes(6).toString("hex")}`;
    this.#projects.push({ projectId, name, archived });
    return projectId;
  }

  has(projectId: string): boolean {
    return this.#projects.some((project) => project.projectId === projectId);
  }

  all(): FakeProject[] {
    return [...this.#projects];
  }

  /** `GET /projects`. `conversationCount` tells how many conversations a project holds. */
  list(conversationCount: (projectId: string) => number): Answer {
    const projects = this.#projects.map((project) =>
      this.#served(project, conversationCount(project.projectId)),
    );
    return { status: 200, body: { projects, total: projects.length } };
  }

  /** `POST /projects`: creates a project and answers 201 with it. */
  create(body: unknown): Answer {
    const name = isRecord(body) ? body.name : undefined;
    if (typeof name !== "string" || name === "") {
      return undocumented("name is not a non-empty string");
    }
    const projectId = this.add(name, false);
    return { status: 201, body: this.#served({ projectId, name, archived: false }, 0) };
  }

  #served(project: FakeProject, conversationCount: number): JsonRecord {
    return {
      project_id: project.projectId,
      name: project.name,
      description: "",
      conversation_count: conversationCount,
      // docs/protocol.md does not record the type of `archived_at`. The fake sends null for a
      // project in use and a timestamp for an archived one.
      archived_at: project.archived ? TIMESTAMP : null,
      updated_at: TIMESTAMP,
    };
  }
}
