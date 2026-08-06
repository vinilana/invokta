import { describe, expect, it, vi } from "vitest";

import {
  createAdminIdTokenVerifier,
  type FirebaseAdminAuth,
  type FirebaseIdTokenClaims,
  IdTokenVerificationUnavailableError,
  isInvalidIdTokenError,
} from "../src/identity/verifier.js";

const idToken = "header.payload.signature";

const decoded: FirebaseIdTokenClaims = {
  iss: "https://securetoken.google.com/demo-invokta-engine",
  aud: "demo-invokta-engine",
  sub: "uid-123",
};

function adminAuthReturning(
  claims: FirebaseIdTokenClaims,
): FirebaseAdminAuth & {
  readonly verifyIdToken: ReturnType<typeof vi.fn>;
} {
  return { verifyIdToken: vi.fn(async () => claims) };
}

function adminAuthFailingWith(error: unknown): FirebaseAdminAuth {
  return {
    verifyIdToken: async () => {
      throw error;
    },
  };
}

function firebaseError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`Firebase said: ${idToken} is invalid.`), {
    code,
  });
}

describe("admin sdk id token verifier", () => {
  it("checks revocation by default and returns the decoded claims", async () => {
    const auth = adminAuthReturning(decoded);
    const verifier = createAdminIdTokenVerifier(auth);

    await expect(
      verifier.verifyIdToken(idToken, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(decoded);
    expect(auth.verifyIdToken).toHaveBeenCalledWith(idToken, true);
  });

  it("can be configured to skip the revocation check", async () => {
    const auth = adminAuthReturning(decoded);
    const verifier = createAdminIdTokenVerifier(auth, { checkRevoked: false });

    await verifier.verifyIdToken(idToken, {
      signal: new AbortController().signal,
    });

    expect(auth.verifyIdToken).toHaveBeenCalledWith(idToken, false);
  });

  it.each([
    "auth/id-token-expired",
    "auth/id-token-revoked",
    "auth/invalid-id-token",
    "auth/argument-error",
    "auth/invalid-argument",
    "auth/user-disabled",
    "auth/user-not-found",
  ])("maps %s to an invalid credential", async (code) => {
    const verifier = createAdminIdTokenVerifier(
      adminAuthFailingWith(firebaseError(code)),
    );

    await expect(
      verifier.verifyIdToken(idToken, {
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
  });

  it("rejects with a sanitized error for an infrastructure failure", async () => {
    const verifier = createAdminIdTokenVerifier(
      adminAuthFailingWith(
        Object.assign(new Error(`socket hang up while sending ${idToken}`), {
          code: "ECONNRESET",
        }),
      ),
    );

    const rejection = await verifier
      .verifyIdToken(idToken, { signal: new AbortController().signal })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toBeInstanceOf(IdTokenVerificationUnavailableError);
    expect((rejection as Error).message).not.toContain(idToken);
    expect((rejection as Error).message).not.toContain("socket hang up");
    expect((rejection as Error).cause).toBeUndefined();
  });

  it("rejects when the request is already aborted", async () => {
    const auth = adminAuthReturning(decoded);
    const verifier = createAdminIdTokenVerifier(auth);

    await expect(
      verifier.verifyIdToken(idToken, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(IdTokenVerificationUnavailableError);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects when the caller aborts while the provider is pending", async () => {
    const controller = new AbortController();
    const verifier = createAdminIdTokenVerifier({
      verifyIdToken: () => new Promise<FirebaseIdTokenClaims>(() => undefined),
    });

    const pending = verifier.verifyIdToken(idToken, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(
      IdTokenVerificationUnavailableError,
    );
  });

  it("bounds its own call with a timeout", async () => {
    const verifier = createAdminIdTokenVerifier(
      {
        verifyIdToken: () =>
          new Promise<FirebaseIdTokenClaims>(() => undefined),
      },
      { timeoutMs: 5 },
    );

    await expect(
      verifier.verifyIdToken(idToken, {
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(IdTokenVerificationUnavailableError);
  });

  it("rejects an unusable timeout at construction time", () => {
    expect(() =>
      createAdminIdTokenVerifier(adminAuthReturning(decoded), {
        timeoutMs: 0,
      }),
    ).toThrow(TypeError);
  });

  it("recognizes only documented invalid-credential error codes", () => {
    expect(isInvalidIdTokenError(firebaseError("auth/id-token-expired"))).toBe(
      true,
    );
    expect(isInvalidIdTokenError(firebaseError("auth/internal-error"))).toBe(
      false,
    );
    expect(isInvalidIdTokenError(new Error("no code"))).toBe(false);
    expect(isInvalidIdTokenError("auth/id-token-expired")).toBe(false);
    expect(isInvalidIdTokenError(null)).toBe(false);
  });
});
