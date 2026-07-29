import { serveMcpHttp } from "@invokta/mcp";

import { engine } from "./engine.js";

const expectedToken = process.env.HELLO_ENGINE_DEMO_TOKEN;
if (expectedToken === undefined || expectedToken === "") {
  throw new Error(
    "HELLO_ENGINE_DEMO_TOKEN is required for the local authentication demo.",
  );
}

const configuredPort = process.env.HELLO_ENGINE_PORT;
const port = configuredPort === undefined ? 3000 : Number(configuredPort);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("HELLO_ENGINE_PORT must be an integer from 0 to 65535.");
}

const server = await serveMcpHttp(engine, {
  port,
  auth: {
    mode: "required",
    authenticate(request) {
      if (request.headers.get("authorization") !== `Bearer ${expectedToken}`) {
        return null;
      }
      return { id: "demo:http-client" };
    },
  },
});

const address = server.address();
process.stderr.write(
  `Hello Engine MCP HTTP listening on http://${address.host}:${address.port}/mcp\n`,
);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
