import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "client-facade-fixture", version: "1.2.3" },
  {
    capabilities: { tools: {} },
    instructions: "Use only explicit fixture calls.",
  },
);

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

server.setRequestHandler(ListToolsRequestSchema, (request) => {
  if (request.params?.cursor === undefined) {
    return {
      tools: [
        {
          name: "fixture.inspect",
          title: "Inspect fixture",
          description: "Returns the exact child launch observations.",
          inputSchema,
          annotations: { readOnlyHint: true },
        },
      ],
      nextCursor: "",
    };
  }
  if (request.params.cursor === "") {
    return {
      tools: [
        {
          name: "fixture.wait",
          description: "Waits until the current request is cancelled.",
          inputSchema,
        },
        {
          name: "fixture.error",
          description: "Returns an MCP tool-level error.",
          inputSchema,
        },
        {
          name: "fixture.large",
          description: "Returns a response beyond the client message boundary.",
          inputSchema,
        },
      ],
    };
  }
  throw new Error("Unexpected fixture cursor.");
});

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === "fixture.inspect") {
    const structuredContent = {
      arguments: process.argv.slice(2),
      environmentKeys: Object.keys(process.env).sort(),
      explicitEnvironment: process.env.FACADE_EXPLICIT,
      value: request.params.arguments?.value,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }
  if (request.params.name === "fixture.error") {
    return {
      isError: true,
      content: [{ type: "text", text: "fixture tool error" }],
    };
  }
  if (request.params.name === "fixture.large") {
    return {
      content: [{ type: "text", text: "x".repeat(10 * 1024 * 1024) }],
    };
  }
  if (request.params.name === "fixture.wait") {
    await new Promise((resolve) => {
      if (extra.signal.aborted) resolve(undefined);
      else extra.signal.addEventListener("abort", resolve, { once: true });
    });
    return {
      isError: true,
      content: [{ type: "text", text: "fixture request cancelled" }],
    };
  }
  throw new Error("Unexpected fixture tool.");
});

await server.connect(new StdioServerTransport());
