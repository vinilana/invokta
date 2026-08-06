import { describe, expect, it } from "vitest";

import { engine } from "../src/engine.js";

describe("auth cognito engine", () => {
  it("describes the authenticated principal without echoing input", async () => {
    const result = await engine.invoke(
      "identity.whoami",
      {},
      {
        principal: {
          id: "8b7e0c1e-4f2a-4c39-9b4f-2a1d6f5c0e11",
          attributes: {
            clientId: "1example23456789",
            scopes: ["engine/invoke"],
            groups: ["support-engineers"],
          },
        },
      },
    );

    expect(result).toEqual({
      principalId: "8b7e0c1e-4f2a-4c39-9b4f-2a1d6f5c0e11",
      attributes: {
        clientId: "1example23456789",
        scopes: ["engine/invoke"],
        groups: ["support-engineers"],
      },
    });
  });

  it("reports an empty attribute set for a principal without attributes", async () => {
    await expect(
      engine.invoke("identity.whoami", {}, { principal: { id: "sub-only" } }),
    ).resolves.toEqual({ principalId: "sub-only", attributes: {} });
  });

  it("denies an anonymous caller", async () => {
    await expect(engine.invoke("identity.whoami", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
