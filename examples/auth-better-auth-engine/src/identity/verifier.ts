import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

import { type BetterAuthClaims, readBetterAuthClaims } from "./principal.js";

/**
 * Better Auth's JWT plugin mounts its JWKS document under the auth base path.
 * With the default base path `/api/auth` and the default `jwksPath` of
 * `/jwks`, the document is served at `<app base URL>/api/auth/jwks`.
 */
export const betterAuthJwksPath = "/api/auth/jwks";

/** Better Auth signs with EdDSA over Ed25519 unless the app changes the algorithm. */
const defaultAlgorithms = Object.freeze(["EdDSA"]);

const defaultJwksTimeoutMs = 5_000;

/**
 * jose error codes that mean "this credential is not acceptable". Anything
 * else means the check could not be completed and must surface as an
 * infrastructure failure, not as a silent denial.
 */
const invalidCredentialCodes: ReadonlySet<string> = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

/**
 * Raised when the identity check itself could not run: the JWKS endpoint is
 * unreachable, the key set is unusable, or the request was cancelled. The MCP
 * HTTP adapter turns this into a sanitized HTTP 500 instead of a 401, so an
 * outage is never reported to a client as a bad credential.
 *
 * The message is a fixed sentence and the cause is deliberately dropped: a
 * jose or fetch error can quote the token or the JWKS response body.
 */
export class IdentityVerificationUnavailableError extends Error {
  constructor(message = "Better Auth token verification is unavailable.") {
    super(message);
    this.name = "IdentityVerificationUnavailableError";
  }
}

export interface BetterAuthTokenVerifier {
  verify(
    token: string,
    options: { readonly signal: AbortSignal },
  ): Promise<BetterAuthClaims | null>;
}

export interface BetterAuthJwtVerifierOptions {
  /** Better Auth's `jwt.issuer`, which defaults to the app base URL. */
  readonly issuer: string;
  /** Better Auth's `jwt.audience`, which also defaults to the app base URL. */
  readonly audience: string;
  /**
   * Key resolution. Production wiring passes
   * {@link createBetterAuthRemoteKeySet}; tests pass a local key set so
   * signature verification stays real without any network call.
   */
  readonly keys: JWTVerifyGetKey;
  readonly algorithms?: ReadonlyArray<string>;
  readonly clockToleranceSeconds?: number;
}

export interface BetterAuthRemoteKeySetOptions {
  /** The app base URL, for example `https://app.example.com`. */
  readonly baseUrl: string;
  /** Bounds the JWKS fetch. Defaults to five seconds. */
  readonly timeoutMs?: number;
}

/** Builds the JWKS URL the JWT plugin serves for an app base URL. */
export function betterAuthJwksUrl(baseUrl: string): URL {
  return new URL(
    betterAuthJwksPath,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
}

/** Production key resolution: the app's own JWKS document, fetched and cached. */
export function createBetterAuthRemoteKeySet(
  options: BetterAuthRemoteKeySetOptions,
): JWTVerifyGetKey {
  return createRemoteJWKSet(betterAuthJwksUrl(options.baseUrl), {
    timeoutDuration: options.timeoutMs ?? defaultJwksTimeoutMs,
  });
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Fails fast when the caller has already given up, and stops waiting on the
 * key set when it gives up mid-check, so the verifier never outlives its
 * request.
 */
async function untilAborted<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) {
    throw new IdentityVerificationUnavailableError(
      "Better Auth token verification was cancelled.",
    );
  }
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        new IdentityVerificationUnavailableError(
          "Better Auth token verification was cancelled.",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Verifies a Better Auth JWT and narrows it to the claims this engine trusts.
 *
 * Returns the claims for an acceptable token, `null` for any unacceptable one,
 * and throws {@link IdentityVerificationUnavailableError} only when the check
 * could not be completed.
 */
export function createBetterAuthJwtVerifier(
  options: BetterAuthJwtVerifierOptions,
): BetterAuthTokenVerifier {
  const algorithms = [...(options.algorithms ?? defaultAlgorithms)];
  return {
    async verify(token, { signal }) {
      const verified = await untilAborted(
        jwtVerify(token, options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms,
          ...(options.clockToleranceSeconds === undefined
            ? {}
            : { clockTolerance: options.clockToleranceSeconds }),
        }),
        signal,
      ).catch((error: unknown) => {
        if (error instanceof IdentityVerificationUnavailableError) throw error;
        const code = readErrorCode(error);
        if (code !== undefined && invalidCredentialCodes.has(code)) return null;
        throw new IdentityVerificationUnavailableError();
      });
      return verified === null ? null : readBetterAuthClaims(verified.payload);
    },
  };
}
