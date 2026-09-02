/**
 * The request path of an Invokta MCP Streamable HTTP endpoint. The adapter
 * serves `/mcp` by default and may mount the same endpoint under a prefix so
 * several engines can share one origin. This module mirrors the adapter's
 * rule so the toolkit accepts exactly the paths the adapter can serve:
 * unreserved ASCII segments, no dot segments, no percent encoding, no empty
 * segment, no trailing slash, a bounded size, and a final `mcp` segment.
 */

export const mcpPathMaxBytes = 256;

const segmentPattern = /^[A-Za-z0-9._~-]+$/u;

export function isCanonicalMcpPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > mcpPathMaxBytes ||
    !value.startsWith("/")
  ) {
    return false;
  }
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (!segmentPattern.test(segment) || segment === "." || segment === "..") {
      return false;
    }
  }
  return segments[segments.length - 1] === "mcp";
}
