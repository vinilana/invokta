import { createServer, type Server as NodeHttpServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it } from "vitest";

function listen(server: NodeHttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The compatibility server did not bind to TCP."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

it("keeps the SDK Node HTTP transport compatible with the Hono resolution", async () => {
  const mcpServer = new McpServer(
    { name: "sdk-node-transport-compatibility", version: "0.0.0-test" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport as unknown as Transport);

  const nodeServer = createServer((request, response) => {
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });

  try {
    const port = await listen(nodeServer);
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "sdk-node-transport-compatibility-client",
            version: "0.0.0-test",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "initialize",
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: {
          name: "sdk-node-transport-compatibility",
          version: "0.0.0-test",
        },
      },
    });
  } finally {
    await close(nodeServer);
    await mcpServer.close();
  }
});
