/**
 * Firebase ID token verification port.
 *
 * The engine never sees a credential: the composition root verifies the ID
 * token and hands the hook a decoded, already trusted claim set. This module
 * defines that port plus one adapter for the Firebase Admin SDK. The adapter is
 * written against a structural view of `getAuth()`, so this example depends on
 * no provider SDK while staying a drop-in for the real one.
 */

/**
 * The claims this example reads from a verified Firebase ID token. Firebase
 * places custom claims at the top level, so the index signature is part of the
 * contract. Every value is still checked at runtime before it reaches a
 * principal: the declared types describe the provider's documented shape, not a
 * guarantee about a specific token.
 */
export interface FirebaseIdTokenClaims {
  readonly iss?: string;
  readonly aud?: string;
  readonly sub?: string;
  readonly uid?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly auth_time?: number;
  readonly exp?: number;
  readonly firebase?: {
    readonly sign_in_provider?: string;
    readonly tenant?: string;
  };
  readonly [claim: string]: unknown;
}

/**
 * Verifies one Firebase ID token.
 *
 * Resolves with the decoded claims for a valid token, resolves with `null` for
 * any invalid credential, and rejects only when verification could not complete
 * at all. The hook maps those three outcomes to a principal, HTTP 401, and
 * HTTP 500.
 */
export interface FirebaseIdTokenVerifier {
  verifyIdToken(
    idToken: string,
    options: { readonly signal: AbortSignal },
  ): Promise<FirebaseIdTokenClaims | null>;
}

/**
 * Raised when verification could not complete: a network failure, a timeout, or
 * a cancelled request. The message is fixed and carries no token, provider
 * message, or cause, so nothing sensitive can reach a log through it.
 */
export class IdTokenVerificationUnavailableError extends Error {
  constructor() {
    super("Firebase ID token verification could not complete.");
    this.name = "IdTokenVerificationUnavailableError";
  }
}

/**
 * The part of `firebase-admin/auth`'s `Auth` this example uses. `getAuth()`
 * satisfies it structurally, so the production composition root passes the real
 * object and the tests pass a fake.
 */
export interface FirebaseAdminAuth {
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean,
  ): Promise<FirebaseIdTokenClaims>;
}

/**
 * Admin SDK error codes that mean "this credential is not valid", from the
 * Admin Authentication API error reference. `auth/argument-error` is the legacy
 * code the SDK raises for a malformed token argument. Every other code is
 * treated as an infrastructure failure, so an unknown failure never silently
 * degrades into a 401.
 */
export const INVALID_ID_TOKEN_ERROR_CODES: ReadonlySet<string> = new Set([
  "auth/argument-error",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-argument",
  "auth/invalid-id-token",
  "auth/user-disabled",
  "auth/user-not-found",
]);

export function isInvalidIdTokenError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && INVALID_ID_TOKEN_ERROR_CODES.has(code);
}

export interface AdminIdTokenVerifierOptions {
  /**
   * Passed to `verifyIdToken` as its `checkRevoked` argument. It costs one
   * extra provider lookup per request and detects tokens revoked before their
   * one-hour expiry. Defaults to `true`.
   */
  readonly checkRevoked?: boolean;
  /** Upper bound for one verification call. Defaults to 5000 ms. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function settleWithSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Adapts the Firebase Admin SDK to the verifier port. The SDK validates the
 * signature, expiry, issuer, and audience of the ID token; this adapter adds
 * the failure classification and the I/O bound the hook contract requires.
 */
export function createAdminIdTokenVerifier(
  auth: FirebaseAdminAuth,
  options: AdminIdTokenVerifierOptions = {},
): FirebaseIdTokenVerifier {
  const checkRevoked = options.checkRevoked ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer.");
  }

  return {
    async verifyIdToken(idToken, { signal }) {
      // The provider call is bounded by both the caller's cancellation and this
      // verifier's own deadline, because the SDK takes neither.
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      try {
        // A cancelled request never reaches the provider.
        if (bounded.aborted) throw bounded.reason;
        return await settleWithSignal(
          auth.verifyIdToken(idToken, checkRevoked),
          bounded,
        );
      } catch (error) {
        if (isInvalidIdTokenError(error)) return null;
        throw new IdTokenVerificationUnavailableError();
      }
    },
  };
}
