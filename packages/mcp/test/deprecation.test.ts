import { createEngine, defineCapability, type Engine } from "@invokta/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMcpServer } from "../src/protocol-server.js";

const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

async function connect(engine: Engine) {
  const server = createMcpServer(engine, {
    principal: null,
    source: "mcp-stdio",
  });
  const client = new Client(
    { name: "mcp-deprecation-test", version: "0.0.0-test" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
}

const echo = {
  input: z.object({ text: z.string() }),
  output: z.object({ echoed: z.string() }),
  access: "public",
  async run({ input }: { input: { text: string } }) {
    return { echoed: input.text };
  },
} as const;

describe("MCP deprecation surfacing", () => {
  it("prefixes the tool description and publishes the notice in _meta", async () => {
    const engine = createEngine({
      name: "deprecation-engine",
      version: "2.0.0",
      capabilities: {
        "support.classify": defineCapability({
          ...echo,
          title: "Classify",
          description: "Classifies a support ticket.",
          deprecated: {
            reason: "Superseded by the triage flow.",
            since: "2.0.0",
            replacement: "support.triage",
          },
        }),
        "support.legacy": defineCapability({
          ...echo,
          description: "Returns legacy data.",
          deprecated: { reason: "Retired without a replacement." },
        }),
        "support.triage": defineCapability({
          ...echo,
          description: "Triages a support ticket.",
        }),
      },
    });
    const client = await connect(engine);

    const { tools } = await client.listTools();

    expect(tools).toEqual([
      {
        name: "support_classify",
        title: "Classify",
        description:
          "Deprecated since 2.0.0: Superseded by the triage flow.\nReplacement: support.triage\n\nClassifies a support ticket.",
        inputSchema: engine.describe("support.classify").inputSchema,
        outputSchema: engine.describe("support.classify").outputSchema,
        _meta: {
          "dev.invokta/deprecated": {
            reason: "Superseded by the triage flow.",
            since: "2.0.0",
            replacement: "support.triage",
          },
        },
      },
      {
        name: "support_legacy",
        description:
          "Deprecated: Retired without a replacement.\n\nReturns legacy data.",
        inputSchema: engine.describe("support.legacy").inputSchema,
        outputSchema: engine.describe("support.legacy").outputSchema,
        _meta: {
          "dev.invokta/deprecated": {
            reason: "Retired without a replacement.",
          },
        },
      },
      {
        name: "support_triage",
        description: "Triages a support ticket.",
        inputSchema: engine.describe("support.triage").inputSchema,
        outputSchema: engine.describe("support.triage").outputSchema,
      },
    ]);
  });

  it("keeps calls to a deprecated tool on the unchanged invoke path", async () => {
    const engine = createEngine({
      name: "deprecation-engine",
      version: "2.0.0",
      capabilities: {
        "support.legacy": defineCapability({
          ...echo,
          description: "Returns legacy data.",
          deprecated: { reason: "Retired." },
        }),
      },
    });
    const invoke = vi.spyOn(engine, "invoke");
    const client = await connect(engine);

    const result = await client.callTool({
      name: "support_legacy",
      arguments: { text: "still works" },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: '{"echoed":"still works"}' }],
      structuredContent: { echoed: "still works" },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toBe("support.legacy");
  });
});
