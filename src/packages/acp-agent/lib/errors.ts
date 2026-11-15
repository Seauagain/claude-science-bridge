import { RequestError } from "@agentclientprotocol/sdk";
import { ProjectLinkError } from "../../project-link/index.ts";
import { ScienceDaemonError } from "../../science-daemon/index.ts";

/** JSON-RPC: the request cannot be served as things stand. */
export const INVALID_REQUEST = -32600;
/** JSON-RPC: the request names something the agent does not have, or a value it cannot take. */
export const INVALID_PARAMS = -32602;
/** JSON-RPC: the agent failed to serve a request that was in order. */
export const INTERNAL_ERROR = -32603;

/** Passes protocol errors through and turns this project's own errors into protocol errors. */
export function rethrowAsRequestError(error: unknown): never {
  if (error instanceof RequestError) throw error;
  if (error instanceof ScienceDaemonError || error instanceof ProjectLinkError) {
    throw new RequestError(INTERNAL_ERROR, error.message);
  }
  throw error;
}
