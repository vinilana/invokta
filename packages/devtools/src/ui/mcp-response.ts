export interface ParsedMcpResponse {
  readonly message?: unknown;
  readonly raw: string;
}

/**
 * Parses an MCP Streamable HTTP response body. The engine host answers with
 * plain JSON, but the transport contract also permits SSE-framed bodies, so
 * both shapes are accepted: for an event stream, the last `data:` payload is
 * the response message.
 */
export function parseMcpResponse(
  contentType: string | null,
  body: string,
): ParsedMcpResponse {
  if (contentType?.includes("text/event-stream")) {
    let lastData: string | undefined;
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("data:")) lastData = line.slice(5).trim();
    }
    if (lastData === undefined) return { raw: body };
    try {
      return { message: JSON.parse(lastData), raw: body };
    } catch {
      return { raw: body };
    }
  }
  try {
    return { message: JSON.parse(body), raw: body };
  } catch {
    return { raw: body };
  }
}
