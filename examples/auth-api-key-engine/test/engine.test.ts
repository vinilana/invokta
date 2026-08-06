import { describe, expect, it } from "vitest";

import { createApiKeyEngine } from "../src/engine.js";
import { toPrincipal } from "../src/identity/principal.js";

const principal = toPrincipal({
  keyId: "svc_reports_2026a",
  serviceName: "reports-worker",
  scopes: ["identity:read"],
});

describe("identity.whoami", () => {
  it("reports the identity the verifier proved, not the caller input", async () => {
    const engine = createApiKeyEngine();

    await expect(
      engine.invoke("identity.whoami", {}, { principal }),
    ).resolves.toEqual({
      principalId: "reports-worker",
      attributes: { keyId: "svc_reports_2026a", scopes: ["identity:read"] },
    });
  });

  it("denies an anonymous caller", async () => {
    const engine = createApiKeyEngine();

    await expect(engine.invoke("identity.whoami", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
