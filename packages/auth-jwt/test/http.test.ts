import { createEngine, defineCapability } from "@invokta/core";
import { createHttpHandler } from "@invokta/http";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createJwtBearerAuthenticator } from "../src/index.js";
import {
  createTestKeys,
  mintToken,
  type TestKeys,
  testAudience,
  testIssuer,
} from "./support/tokens.js";

const engine = createEngine({
  name: "auth-jwt-http-test-engine",
  version: "0.0.0-test",
  capabilities: {
    "identity.whoami": defineCapability({
      description: "Return the verified identity of the current caller.",
      input: z.object({}),
      output: z.object({ principalId: z.string() }),
      access: "authenticated",
      async run({ context }) {
        return { principalId: context.principal?.id ?? "" };
      },
    }),
  },
});

let keys: TestKeys;

beforeAll(async () => {
  keys = await createTestKeys();
});

function invoke(authorization: string | undefined): Request {
  return new Request("http://127.0.0.1/capabilities/identity.whoami", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: "{}",
  });
}

describe("createJwtBearerAuthenticator with @invokta/http", () => {
  it("is the plain HTTP authenticate hook as-is", async () => {
    const handler = createHttpHandler(engine, {
      auth: {
        mode: "required",
        authenticate: createJwtBearerAuthenticator({
          issuer: testIssuer,
          audience: testAudience,
          algorithms: ["RS256"],
          jwks: keys.jwks,
        }),
      },
    });

    const verified = await handler(invoke(`Bearer ${await mintToken(keys)}`));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ principalId: "user-42" });

    for (const authorization of [undefined, "Bearer not-a-jwt"]) {
      const rejected = await handler(invoke(authorization));
      expect(rejected.status).toBe(401);
      expect(rejected.headers.get("www-authenticate")).toBe("Bearer");
    }
  });
});
