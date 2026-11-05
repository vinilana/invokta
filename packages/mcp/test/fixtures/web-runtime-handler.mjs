import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

import { createMcpHttpHandler } from "../../dist/web.js";

const engine = createEngine({
  name: "web-runtime-engine",
  version: "0.1.0",
  capabilities: {
    "support.inspect": defineCapability({
      description: "Returns the HTTP execution context.",
      input: z.object({ value: z.string() }),
      output: z.object({
        value: z.string(),
        principalId: z.string(),
        source: z.string(),
      }),
      access: "authenticated",
      async run({ input, context }) {
        return {
          value: input.value,
          principalId: context.principal?.id ?? "anonymous",
          source: context.source,
        };
      },
    }),
    "support.proxied": defineCapability({
      description: "Returns a forwarding proxy from its output schema.",
      input: z.object({}),
      output: {
        "~standard": {
          version: 1,
          vendor: "web-runtime-fixture",
          validate: () => ({ value: new Proxy({ ok: true }, {}) }),
          jsonSchema: {
            input: () => ({ type: "object" }),
            output: () => ({ type: "object" }),
          },
        },
      },
      access: "authenticated",
      async run() {
        return { ok: true };
      },
    }),
  },
});

const handler = createMcpHttpHandler(engine, {
  auth: {
    mode: "required",
    authenticate(request) {
      return request.headers.get("authorization") === "Bearer alice"
        ? { id: "user:alice" }
        : null;
    },
  },
});

function post(body, authorization) {
  return handler(
    new Request("http://127.0.0.1:8787/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify(body),
    }),
  );
}

function toolCall(id, name, args) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

const listed = await post(
  { jsonrpc: "2.0", id: 1, method: "tools/list" },
  "Bearer alice",
);
const called = await post(
  toolCall(2, "support_inspect", { value: "portable" }),
  "Bearer alice",
);
const proxied = await post(toolCall(3, "support_proxied", {}), "Bearer alice");
const unauthorized = await post(toolCall(4, "support_inspect", { value: "x" }));

process.stdout.write(
  `${JSON.stringify({
    getBuiltinModule: typeof process.getBuiltinModule,
    listed: { status: listed.status, body: await listed.json() },
    called: { status: called.status, body: await called.json() },
    proxied: { status: proxied.status, body: await proxied.json() },
    unauthorized: {
      status: unauthorized.status,
      challenge: unauthorized.headers.get("www-authenticate"),
    },
  })}\n`,
);
