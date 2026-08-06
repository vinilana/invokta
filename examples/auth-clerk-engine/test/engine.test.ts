import { describe, expect, it } from "vitest";

import { createAuthClerkEngine } from "../src/engine.js";
import { toPrincipal } from "../src/identity/principal.js";

describe("auth-clerk engine", () => {
  it("reports the verified identity of an authenticated caller", async () => {
    const engine = createAuthClerkEngine();

    const result = await engine.invoke(
      "identity.whoami",
      {},
      {
        principal: toPrincipal({
          sub: "user_2abcDEF",
          sid: "sess_2abcDEF",
          org_id: "org_2xyz",
          // The verifier normalizes the role to the v2 form without the
          // "org:" prefix before the claims reach this mapping.
          org_role: "admin",
        }),
      },
    );

    expect(result).toEqual({
      principalId: "user_2abcDEF",
      attributes: {
        sessionId: "sess_2abcDEF",
        organizationId: "org_2xyz",
        organizationRole: "admin",
      },
    });
  });

  it("ignores caller-supplied identity fields in the tool input", async () => {
    const engine = createAuthClerkEngine();

    const spoofedInput = { principalId: "user_attacker" } as unknown as Record<
      string,
      never
    >;

    const result = await engine.invoke("identity.whoami", spoofedInput, {
      principal: toPrincipal({ sub: "user_2abcDEF" }),
    });

    expect(result).toEqual({ principalId: "user_2abcDEF", attributes: {} });
  });

  it("denies an anonymous caller", async () => {
    const engine = createAuthClerkEngine();

    await expect(engine.invoke("identity.whoami", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
