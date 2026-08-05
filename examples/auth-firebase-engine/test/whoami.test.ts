import { describe, expect, it } from "vitest";

import { createFirebaseAuthEngine } from "../src/engine.js";

describe("identity.whoami", () => {
  it("returns data derived from the trusted principal", async () => {
    const engine = createFirebaseAuthEngine();

    await expect(
      engine.invoke(
        "identity.whoami",
        {},
        {
          principal: {
            id: "uid-123",
            attributes: { email: "ada@example.com", emailVerified: true },
          },
        },
      ),
    ).resolves.toEqual({
      principalId: "uid-123",
      attributes: { email: "ada@example.com", emailVerified: true },
    });
  });

  it("denies an anonymous caller", async () => {
    const engine = createFirebaseAuthEngine();

    await expect(engine.invoke("identity.whoami", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
