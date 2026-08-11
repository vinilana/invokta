import { createHash } from "node:crypto";

const MAX_MCP_TOOL_NAME_LENGTH = 64;
const MCP_TOOL_NAME_HASH_LENGTH = 12;
const MCP_TOOL_NAME_PREFIX_LENGTH =
  MAX_MCP_TOOL_NAME_LENGTH - MCP_TOOL_NAME_HASH_LENGTH - 1;

/** Derives the portable MCP tool name published for one domain capability ID. */
export function toMcpToolName(capabilityId: string): string {
  if (typeof capabilityId !== "string") {
    throw new TypeError("capabilityId must be a string.");
  }
  const portable = capabilityId.replace(/[^a-zA-Z0-9_-]/gu, "_") || "_";
  if (portable.length <= MAX_MCP_TOOL_NAME_LENGTH) return portable;

  const hash = createHash("sha256")
    .update(capabilityId, "utf8")
    .digest("hex")
    .slice(0, MCP_TOOL_NAME_HASH_LENGTH);
  return `${portable.slice(0, MCP_TOOL_NAME_PREFIX_LENGTH)}_${hash}`;
}
