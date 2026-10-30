import {
  connectMcpClient,
  type McpClientToolResult,
  type McpJsonValue,
} from "@invokta/mcp";

const usage =
  'Usage: parallel-search search "<objective>" "<query>" ["<query>" ...] | fetch <http(s)-url> [<url> ...] (maximum 20 URLs)';

function toolRequest(args: readonly string[]): {
  readonly name: string;
  readonly arguments: Readonly<Record<string, McpJsonValue>>;
} {
  const [command, first, ...rest] = args;
  if (first === undefined || first.trim() === "") throw new Error(usage);
  if (command === "search") {
    if (rest.length === 0 || rest.some((query) => query.trim() === "")) {
      throw new Error(usage);
    }
    return {
      name: "web_search",
      arguments: { objective: first, search_queries: rest },
    };
  }
  if (command === "fetch") {
    const urls = [first, ...rest];
    if (urls.length > 20) throw new Error(usage);
    for (const value of urls) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(usage);
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username !== "" ||
        url.password !== ""
      ) {
        throw new Error(usage);
      }
    }
    return { name: "web_fetch", arguments: { urls } };
  }
  throw new Error(usage);
}

/** One explicit tool call through Invokta's client facade, without credentials. */
export async function runParallelCommand(
  args: readonly string[],
  options: { readonly url?: string; readonly signal?: AbortSignal } = {},
): Promise<McpClientToolResult["response"]> {
  const request = toolRequest(args);
  const deadline = AbortSignal.timeout(60_000);
  const signal =
    options.signal === undefined
      ? deadline
      : AbortSignal.any([deadline, options.signal]);
  const connection = await connectMcpClient(
    {
      transport: "http",
      url: options.url ?? "https://search.parallel.ai/mcp",
      authentication: {
        type: "headers",
        headers: { "User-Agent": "invokta-parallel-search-example/0.1.0" },
      },
    },
    { signal },
  );
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const catalog = await connection.listTools(cursor, { signal });
      if (catalog.tools.some(({ name }) => name === request.name)) {
        const result = await connection.callTool(
          request.name,
          request.arguments,
          { signal },
        );
        return result.response;
      }
      cursor = catalog.nextCursor;
      if (cursor === undefined) {
        throw new Error(`Required MCP tool not found: ${request.name}`);
      }
    }
    throw new Error("MCP tool discovery exceeded 20 pages.");
  } finally {
    await connection.close();
  }
}
