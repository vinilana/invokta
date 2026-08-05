import { describe, expect, it } from "vitest";

import { firebaseIssuer, toPrincipal } from "../src/identity/principal.js";
import type { FirebaseIdTokenClaims } from "../src/identity/verifier.js";

const projectId = "demo-invokta-engine";

function claims(
  overrides: Readonly<Record<string, unknown>> = {},
): FirebaseIdTokenClaims {
  return {
    iss: firebaseIssuer(projectId),
    aud: projectId,
    sub: "uid-123",
    auth_time: 1_754_400_000,
    email: "ada@example.com",
    email_verified: true,
    firebase: { sign_in_provider: "password", tenant: "tenant-a" },
    role: "support-agent",
    ...overrides,
  } as FirebaseIdTokenClaims;
}

describe("firebase claims to principal", () => {
  it("builds the issuer from the project id", () => {
    expect(firebaseIssuer(projectId)).toBe(
      `https://securetoken.google.com/${projectId}`,
    );
  });

  it("maps verified claims to an enumerated principal", () => {
    const principal = toPrincipal(claims(), {
      projectId,
      customClaimNames: ["role"],
    });

    expect(principal).toEqual({
      id: "uid-123",
      attributes: {
        email: "ada@example.com",
        emailVerified: true,
        authTime: 1_754_400_000,
        signInProvider: "password",
        tenantId: "tenant-a",
        customClaims: { role: "support-agent" },
      },
    });
  });

  it("falls back to uid when sub is absent", () => {
    const principal = toPrincipal(claims({ sub: undefined, uid: "uid-456" }), {
      projectId,
    });

    expect(principal?.id).toBe("uid-456");
  });

  it("copies only the enumerated custom claims", () => {
    const principal = toPrincipal(
      claims({ role: "support-agent", secretApiKey: "sk-not-a-claim" }),
      { projectId, customClaimNames: ["role"] },
    );

    expect(principal?.attributes?.customClaims).toEqual({
      role: "support-agent",
    });
    expect(JSON.stringify(principal)).not.toContain("sk-not-a-claim");
  });

  it("keeps unusable custom claim values out of the principal", () => {
    const principal = toPrincipal(
      claims({ role: { nested: "object" }, tier: ["gold", "silver"] }),
      { projectId, customClaimNames: ["role", "tier", "absent"] },
    );

    expect(principal?.attributes?.customClaims).toEqual({
      tier: ["gold", "silver"],
    });
  });

  it("rejects a token issued for another project", () => {
    expect(
      toPrincipal(claims({ iss: firebaseIssuer("other-project") }), {
        projectId,
      }),
    ).toBeNull();
  });

  it("rejects a token whose audience is not the project id", () => {
    expect(toPrincipal(claims({ aud: "other-project" }), { projectId })).toBe(
      null,
    );
  });

  it("rejects claims without a usable subject", () => {
    expect(
      toPrincipal(claims({ sub: undefined, uid: undefined }), { projectId }),
    ).toBeNull();
    expect(toPrincipal(claims({ sub: "   " }), { projectId })).toBeNull();
    expect(toPrincipal(claims({ sub: 42 }), { projectId })).toBeNull();
  });

  it("drops malformed standard claim values instead of trusting them", () => {
    const principal = toPrincipal(
      claims({
        email: "",
        email_verified: "true",
        auth_time: Number.NaN,
        firebase: { sign_in_provider: 7 },
      }),
      { projectId },
    );

    expect(principal).toEqual({ id: "uid-123", attributes: {} });
  });
});
