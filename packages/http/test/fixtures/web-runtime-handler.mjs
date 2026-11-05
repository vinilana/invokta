import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

import { createHttpHandler } from "../../dist/index.js";

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
  },
});

const handler = createHttpHandler(engine, {
  auth: {
    mode: "required",
    authenticate(request) {
      return request.headers.get("authorization") === "Bearer alice"
        ? { id: "user:alice" }
        : null;
    },
  },
});

function request(path, init = {}) {
  return handler(new Request(`http://127.0.0.1:8787${path}`, init));
}

const authorized = { authorization: "Bearer alice" };
const listed = await request("/capabilities", { headers: authorized });
const document = await request("/openapi.json", { headers: authorized });
const invoked = await request("/capabilities/support.inspect", {
  method: "POST",
  headers: { ...authorized, "content-type": "application/json" },
  body: JSON.stringify({ value: "portable" }),
});
const unauthorized = await request("/capabilities");

process.stdout.write(
  `${JSON.stringify({
    getBuiltinModule: typeof process.getBuiltinModule,
    listed: { status: listed.status, body: await listed.json() },
    openapi: {
      status: document.status,
      version: (await document.json()).openapi,
    },
    invoked: { status: invoked.status, body: await invoked.json() },
    unauthorized: {
      status: unauthorized.status,
      challenge: unauthorized.headers.get("www-authenticate"),
    },
  })}\n`,
);
