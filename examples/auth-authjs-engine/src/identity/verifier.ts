import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

import type { VerifiedEngineAccessToken } from "./principal.js";

/**
 * Verification of the short-lived access token this application issues to
 * callers that must reach the engine over HTTP.
 *
 * The token is a signed JWS with an application-owned issuer, audience, and key
 * set. It is deliberately not the Auth.js session cookie: that cookie is an
 * encrypted JWE meant only for the application that holds `AUTH_SECRET`.
 */

/** A sanitized authentication infrastructure failure. It carries no token. */
export class EngineAccessTokenVerificationError extends Error {
  constructor() {
    super("The engine access token could not be verified.");
    this.name = "EngineAccessTokenVerificationError";
  }
}

export interface EngineAccessTokenVerifier {
  verify(
    token: string,
    options: { readonly signal: AbortSignal },
  ): Promise<VerifiedEngineAccessToken | null>;
}

export interface EngineAccessTokenVerifierOptions {
  /**
   * Key resolution port. Production wiring passes `createRemoteJWKSet` over the
   * application's own JWKS endpoint; tests pass `createLocalJWKSet`.
   */
  readonly resolveKey: JWTVerifyGetKey;
  readonly issuer: string;
  readonly audience: string;
  readonly algorithms?: ReadonlyArray<string>;
  readonly clockToleranceSeconds?: number;
  /** Upper bound on this verifier's own I/O. Defaults to 2000 ms. */
  readonly timeoutMs?: number;
  /** Credentials longer than this are rejected before any parsing. */
  readonly maxTokenLength?: number;
}

const defaultAlgorithms = ["ES256"] as const;
const defaultClockToleranceSeconds = 5;
const defaultTimeoutMs = 2_000;
const defaultMaxTokenLength = 4_096;

/**
 * JOSE failures that prove the credential itself is unacceptable. Anything not
 * listed here is treated as an infrastructure failure, so a broken key source
 * can never be reported to a caller as "invalid credential".
 */
const invalidCredentialCodes: ReadonlySet<string> = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWK_INVALID",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

function isInvalidCredential(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && invalidCredentialCodes.has(code);
}

/** Resolves the work, or rejects as soon as the bounding signal aborts. */
async function withinDeadline<Value>(
  work: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  void work.catch(() => undefined);
  if (signal.aborted) throw signal.reason;

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function readScopes(value: unknown): ReadonlyArray<string> {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(" ").filter((scope) => scope !== ""))];
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toVerifiedToken(
  payload: JWTPayload,
): VerifiedEngineAccessToken | null {
  const subject = readOptionalString(payload.sub);
  if (subject === null) return null;

  return {
    subject,
    email: readOptionalString(payload.email),
    name: readOptionalString(payload.name),
    scopes: readScopes(payload.scope),
  };
}

export function createEngineAccessTokenVerifier(
  options: EngineAccessTokenVerifierOptions,
): EngineAccessTokenVerifier {
  const algorithms = [...(options.algorithms ?? defaultAlgorithms)];
  const clockTolerance =
    options.clockToleranceSeconds ?? defaultClockToleranceSeconds;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxTokenLength = options.maxTokenLength ?? defaultMaxTokenLength;

  return {
    async verify(token, { signal }) {
      if (token === "" || token.length > maxTokenLength) return null;

      const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      let payload: JWTPayload;
      try {
        const result = await withinDeadline(
          jwtVerify(token, options.resolveKey, {
            issuer: options.issuer,
            audience: options.audience,
            algorithms,
            clockTolerance,
            requiredClaims: ["sub", "iat", "exp"],
          }),
          bounded,
        );
        payload = result.payload;
      } catch (error) {
        // A rejected credential is a 401; anything else is a 500. The original
        // error is deliberately dropped so no token or endpoint detail leaks.
        if (isInvalidCredential(error)) return null;
        throw new EngineAccessTokenVerificationError();
      }

      return toVerifiedToken(payload);
    },
  };
}
