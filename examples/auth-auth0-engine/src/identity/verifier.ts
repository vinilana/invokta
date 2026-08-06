import {
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

/**
 * Auth0 access token verification for a registered API.
 *
 * Auth0 mints the `iss` claim as the tenant origin with a trailing slash
 * (`https://<tenant-domain>/`) and publishes its signing keys at
 * `https://<tenant-domain>/.well-known/jwks.json`. An access token for a
 * registered API carries that API's identifier in `aud`, so the audience check
 * is required: without it a token minted for another API of the same tenant,
 * or for the tenant's own `/userinfo` endpoint, would be accepted here.
 */

/** Auth0 signs API access tokens with RS256. */
const signingAlgorithms = ["RS256"] as const;

const defaultJwksTimeoutMs = 5_000;
const defaultClockToleranceSeconds = 5;

/**
 * Every jose failure that means "this credential is not valid". Anything else
 * — a JWKS timeout, a transport failure, a caller cancellation — is an
 * infrastructure failure and must not be reported as an invalid credential.
 *
 * `ERR_JWKS_MULTIPLE_MATCHING_KEYS` is deliberately absent: an ambiguous key
 * set is the tenant's key-publication problem, not evidence against the
 * credential, so it surfaces as an infrastructure failure (500) instead of
 * silently rejecting legitimate tokens during a kid-less key rotation.
 */
const invalidCredentialCodes: ReadonlySet<string> = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

/**
 * Raised when the check could not be completed. The message is fixed so that
 * no token, header, or provider payload can reach a log through it.
 */
export class Auth0VerificationUnavailableError extends Error {
  constructor() {
    super("Auth0 access token verification is unavailable.");
    this.name = "Auth0VerificationUnavailableError";
  }
}

export interface Auth0VerifyOptions {
  readonly signal: AbortSignal;
}

export interface Auth0AccessTokenVerifier {
  /** Resolves the verified claims, or `null` for any invalid credential. */
  verify(
    token: string,
    options: Auth0VerifyOptions,
  ): Promise<JWTPayload | null>;
}

export interface Auth0VerifierOptions {
  /** Tenant or custom domain, with or without the `https://` prefix. */
  readonly domain: string;
  /** The API identifier configured in Auth0, matched against `aud`. */
  readonly audience: string;
  /**
   * Key resolution. Production wiring omits it and gets the tenant's remote
   * JWKS; tests inject a local JWKS so signature verification stays real and
   * offline.
   */
  readonly keySource?: JWTVerifyGetKey;
  readonly jwksTimeoutMs?: number;
  readonly clockToleranceSeconds?: number;
}

/** Returns the exact `iss` value Auth0 puts in the tenant's tokens. */
export function auth0Issuer(domain: string): string {
  const trimmed = domain.trim();
  if (trimmed === "") {
    throw new TypeError("An Auth0 domain is required.");
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new TypeError("The Auth0 domain is not a valid origin.");
  }
  if (url.protocol !== "https:") {
    throw new TypeError("The Auth0 domain must use HTTPS.");
  }
  // The trailing slash is part of the claim, not a formatting choice.
  return `${url.origin}/`;
}

/** Returns the tenant's JWKS document URL, derived from the issuer. */
export function auth0JwksUri(domain: string): URL {
  return new URL(".well-known/jwks.json", auth0Issuer(domain));
}

export function createAuth0AccessTokenVerifier(
  options: Auth0VerifierOptions,
): Auth0AccessTokenVerifier {
  const issuer = auth0Issuer(options.domain);
  const audience = options.audience.trim();
  if (audience === "") {
    throw new TypeError("An Auth0 API identifier is required as the audience.");
  }
  const keySource: JWTVerifyGetKey =
    options.keySource ??
    createRemoteJWKSet(auth0JwksUri(options.domain), {
      timeoutDuration: options.jwksTimeoutMs ?? defaultJwksTimeoutMs,
    });

  return {
    async verify(token, { signal }) {
      try {
        signal.throwIfAborted();
        const { payload } = await settleWith(
          jwtVerify(token, keySource, {
            issuer,
            audience,
            algorithms: [...signingAlgorithms],
            // Auth0 always mints these on an API access token; a signed token
            // missing one — notably exp — must not become a permanent
            // credential.
            requiredClaims: ["sub", "iss", "aud", "exp"],
            clockTolerance:
              options.clockToleranceSeconds ?? defaultClockToleranceSeconds,
          }),
          signal,
        );
        return payload;
      } catch (error) {
        if (isInvalidCredential(error)) return null;
        // The provider error may quote the token, so it is never re-thrown.
        throw new Auth0VerificationUnavailableError();
      }
    },
  };
}

function isInvalidCredential(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && invalidCredentialCodes.has(code);
}

/**
 * Bounds the verification by the request's own lifetime. jose bounds its JWKS
 * fetch with `timeoutDuration`; this makes the hook stop observing the result
 * as soon as the adapter cancels the request.
 */
async function settleWith<Value>(
  work: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  const subscription = new AbortController();
  const cancelled = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
      signal: subscription.signal,
    });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    subscription.abort();
  }
}
