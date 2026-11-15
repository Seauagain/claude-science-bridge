import { type ContentBlock, RequestError } from "@agentclientprotocol/sdk";

/**
 * Renders an ACP prompt as the plain text Claude Science receives. Text is passed through and
 * links to resources are sent as their URI, each on its own line.
 *
 * @throws RequestError (invalid params) for content the adapter cannot pass on, such as images.
 */
export function promptText(blocks: readonly ContentBlock[]): string {
  const parts = blocks.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "resource_link") return block.uri;
    throw new RequestError(
      -32602,
      `Claude Science sessions accept text only for now; this prompt contains "${block.type}" content.`,
    );
  });
  return parts.join("\n");
}
