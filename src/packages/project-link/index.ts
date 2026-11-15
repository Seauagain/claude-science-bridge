/**
 * Project links: the marker file that ties a local folder to a Claude Science project.
 *
 * A folder is linked when it, or one of its ancestors, holds `.claude-science/project.json`.
 */
export { findProjectLink } from "./lib/find-project-link.ts";
export { type ProjectLink, ProjectLinkError } from "./lib/project-link.ts";
