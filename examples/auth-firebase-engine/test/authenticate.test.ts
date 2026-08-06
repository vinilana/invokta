import { describe, expect, it, vi } from "vitest";
import { firebaseIssuer } from "../src/identity/principal.js";
import type {
  FirebaseIdTokenClaims,
  FirebaseIdTokenVerifier,
} from "../src/identity/verifier.js";
import { createFirebaseAuthenticate } from "../src/mcp-http.js";

const projectId = "demo-invokta-engine";
const idToken = "header.payload.signature";

const verifiedClaims: FirebaseIdTokenClaims = {
  iss: firebaseIssuer(projectId),
  aud: projectId,
  sub: "uid-123",
  email: "ada@example.com",
  email_verified: true,
  firebase: { sign_in_provider: "password" },
};

function headers(value: string | null) {
  return {
    get: (name: string) =>
      name.toLowerCase() === "authorization" ? value : null,
    has: (name: string) => name.toLowerCase() === "authorization",
  };
}

function request(
  authorization: string | null,
  signal = new AbortController().signal,
) {
  return {
    path: "/mcp",
    method: "POST",
    headers: headers(authorization),
    signal,
  };
}

function verifierReturning(
  claims: FirebaseIdTokenClaims | null,
): FirebaseIdTokenVerifier & {
  readonly verifyIdToken: ReturnType<typeof vi.fn>;
} {
  return {
    verifyIdToken: vi.fn(async () => claims),
  };
}

describe("firebase authentication hook", () => {
  it("returns the mapped principal for a verified id token", async () => {
    const verifier = verifierReturning(verifiedClaims);
    const authenticate = createFirebaseAuthenticate({ verifier, projectId });

    await expect(authenticate(request(`Bearer ${idToken}`))).resolves.toEqual({
      id: "uid-123",
      attributes: {
        email: "ada@example.com",
        emailVerified: true,
        signInProvider: "password",
      },
    });
    expect(verifier.verifyIdToken).toHaveBeenCalledOnce();
    expect(verifier.verifyIdToken.mock.calls[0]?.[0]).toBe(idToken);
  });

  it("passes the request signal to the verifier", async () => {
    const verifier = verifierReturning(verifiedClaims);
    const authenticate = createFirebaseAuthenticate({ verifier, projectId });
    const controller = new AbortController();

    await authenticate(request(`Bearer ${idToken}`, controller.signal));

    expect(verifier.verifyIdToken.mock.calls[0]?.[1]).toEqual({
      signal: controller.signal,
    });
  });

  it("returns null for a missing authorization header", async () => {
    const verifier = verifierReturning(verifiedClaims);
    const authenticate = createFirebaseAuthenticate({ verifier, projectId });

    await expect(authenticate(request(null))).resolves.toBeNull();
    expect(verifier.verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    ["another scheme", `Basic ${idToken}`],
    ["a bearer prefix without a token", "Bearer"],
    ["two credentials in one header", `Bearer ${idToken} extra`],
    ["a value that is not a compact JWS", "Bearer not-a-jwt"],
    ["an empty compact JWS segment", "Bearer header..signature"],
  ])("returns null for %s", async (_case, authorization) => {
    const verifier = verifierReturning(verifiedClaims);
    const authenticate = createFirebaseAuthenticate({ verifier, projectId });

    await expect(authenticate(request(authorization))).resolves.toBeNull();
    expect(verifier.verifyIdToken).not.toHaveBeenCalled();
  });

  it("returns null for an oversized credential without calling the verifier", async () => {
    const verifier = verifierReturning(verifiedClaims);
    const authenticate = createFirebaseAuthenticate({ verifier, projectId });
    const oversized = `a.${"b".repeat(8_192)}.c`;

    await expect(
      authenticate(request(`Bearer ${oversized}`)),
    ).resolves.toBeNull();
    expect(verifier.verifyIdToken).not.toHaveBeenCalled();
  });

  it("returns null when the verifier rejects the credential", async () => {
    const authenticate = createFirebaseAuthenticate({
      verifier: verifierReturning(null),
      projectId,
    });

    await expect(
      authenticate(request(`Bearer ${idToken}`)),
    ).resolves.toBeNull();
  });

  it("returns null when verified claims belong to another project", async () => {
    const authenticate = createFirebaseAuthenticate({
      verifier: verifierReturning({
        ...verifiedClaims,
        aud: "other-project",
      }),
      projectId,
    });

    await expect(
      authenticate(request(`Bearer ${idToken}`)),
    ).resolves.toBeNull();
  });

  it("propagates an infrastructure failure instead of returning null", async () => {
    const failure = new Error("verification backend unavailable");
    const authenticate = createFirebaseAuthenticate({
      verifier: {
        verifyIdToken: async () => {
          throw failure;
        },
      },
      projectId,
    });

    await expect(authenticate(request(`Bearer ${idToken}`))).rejects.toBe(
      failure,
    );
  });

  it("keeps credential material out of the produced principal", async () => {
    const authenticate = createFirebaseAuthenticate({
      verifier: verifierReturning(verifiedClaims),
      projectId,
      customClaimNames: ["role"],
    });

    const principal = await authenticate(request(`Bearer ${idToken}`));

    expect(JSON.stringify(principal)).not.toContain(idToken);
    expect(JSON.stringify(principal)).not.toContain("signature");
  });
});
