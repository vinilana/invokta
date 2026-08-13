import { describe, expect, it } from "vitest";

import { createSelfHostedOAuthEngine } from "../src/engine.js";

describe("self-hosted OAuth engine", () => {
  it("keeps authenticated capabilities fail-closed", async () => {
    const engine = createSelfHostedOAuthEngine();

    await expect(
      engine.invoke("identity.whoami", {}, { principal: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("invokes the example capability through the engine boundary", async () => {
    const engine = createSelfHostedOAuthEngine();

    await expect(
      engine.invoke(
        "identity.whoami",
        {},
        {
          principal: {
            id: "person:owner",
            attributes: {
              clientId: "client:test",
              scopes: ["mcp:tools"],
            },
          },
        },
      ),
    ).resolves.toEqual({
      principalId: "person:owner",
      clientId: "client:test",
      scopes: ["mcp:tools"],
    });
  });
});
