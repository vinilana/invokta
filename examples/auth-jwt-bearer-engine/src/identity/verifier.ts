import type { Principal } from "@invokta/core";
import {
  errors,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
  jwtVerify,
} from "jose";

import { toPrincipal } from "./principal.js";

/**
 * Signature algorithms accepted by default. An allowlist is mandatory: without
 * one, a token can choose its own algorithm and the verifier follows.
 */
export const defaultSignatureAlgorithms: ReadonlyArray<string> = Object.freeze([
  "RS256",
  "ES256",
]);

/** Default bound on the verifier's own key-resolution I/O, in milliseconds. */
export const defaultJwksTimeoutMs = 5_000;

export interface AccessTokenVerifierOptions {
  /** The exact `iss` value this engine accepts. */
  readonly issuer: string;
  /** The resource identifier this engine expects in `aud`. */
  readonly audience: string;
  /**
   * Key resolution. Production wiring passes `createRemoteJWKSet(...)`; tests
   * pass `createLocalJWKSet(...)`, so signature verification stays real without
   * any network access.
   */
  readonly getKey: JWTVerifyGetKey;
  /** Overrides {@link defaultSignatureAlgorithms}. */
  readonly algorithms?: ReadonlyArray<string>;
  /** Clock skew allowance, in seconds. Defaults to none. */
  readonly clockToleranceSeconds?: number;
}

export interface AccessTokenVerifier {
  verify(
    token: string,
    options: { readonly signal: AbortSignal },
  ): Promise<Principal | null>;
}

/**
 * Signals that the check could not complete: the key source was unreachable,
 * the JWKS was unusable, or the request was cancelled mid-flight. The message
 * is a fixed sentence, and no cause is attached, so no token material, URL, or
 * provider response can reach a log through it.
 *
 * The `authenticate` hook lets this propagate, which the adapter turns into a
 * sanitized HTTP 500. An invalid credential resolves to `null` instead.
 */
export class AccessTokenVerificationUnavailableError extends Error {
  constructor() {
    super("Access token verification is unavailable.");
    this.name = "AccessTokenVerificationUnavailableError";
  }
}

/**
 * jose failures that mean "this credential is not acceptable". Everything else
 * — a JWKS timeout, an unusable key set, an unexpected error — is an
 * infrastructure failure and must not be reported as a clean rejection.
 */
const invalidCredentialCodes: ReadonlySet<string> = new Set([
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
  errors.JWKSMultipleMatchingKeys.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWSInvalid.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JWTClaimValidationFailed.code,
  errors.JWTExpired.code,
  errors.JWTInvalid.code,
]);

function isInvalidCredential(error: unknown): boolean {
  return (
    error instanceof errors.JOSEError && invalidCredentialCodes.has(error.code)
  );
}

/**
 * Normalizes an issuer identifier and rejects one this example cannot use.
 *
 * OpenID Connect Discovery requires a terminating `/` to be removed before a
 * well-known suffix is appended, so the same normalization backs every derived
 * URL below.
 */
function normalizeIssuer(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new TypeError("The issuer must be an absolute HTTPS URL.");
  }

  const loopbackDevelopment =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]");
  if (url.protocol !== "https:" && !loopbackDevelopment) {
    throw new TypeError(
      "The issuer must use HTTPS, except for loopback development.",
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "The issuer must not contain credentials, a query, or a fragment.",
    );
  }

  return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
}

/**
 * The OpenID Provider configuration URL for an issuer. Its `jwks_uri` member is
 * the authoritative key-set location; fetch it once at deployment time and pass
 * the result as the JWKS override rather than trusting the convention below.
 */
export function openIdConfigurationUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
}

/**
 * The JWKS location most OIDC providers publish. This is a widespread
 * convention, not a specification requirement: `jwks_uri` in the discovery
 * document is normative, and several providers host their key set elsewhere.
 */
export function conventionalJwksUri(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/jwks.json`;
}

/** Uses an explicit JWKS URI when configured, otherwise the convention. */
export function resolveJwksUri(issuer: string, override?: string): string {
  if (override !== undefined && override !== "") {
    const url = new URL(override);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError("The JWKS URI must be an HTTP(S) URL.");
    }
    return url.href;
  }
  return conventionalJwksUri(issuer);
}

/**
 * Builds the credential verifier used by the `authenticate` hook.
 *
 * Every check the engine's security policy depends on happens here: signature,
 * algorithm allowlist, issuer, audience, expiry, and the presence of the claims
 * the principal mapping needs. The framework defines none of them.
 */
export function createAccessTokenVerifier(
  options: AccessTokenVerifierOptions,
): AccessTokenVerifier {
  const verifyOptions: JWTVerifyOptions = {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: [...(options.algorithms ?? defaultSignatureAlgorithms)],
    requiredClaims: ["sub", "iss", "aud", "exp"],
    ...(options.clockToleranceSeconds === undefined
      ? {}
      : { clockTolerance: options.clockToleranceSeconds }),
  };

  return {
    async verify(token, { signal }) {
      if (signal.aborted) throw new AccessTokenVerificationUnavailableError();

      let removeAbortListener = (): void => undefined;
      const cancellation = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(new AccessTokenVerificationUnavailableError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = (): void => {
          signal.removeEventListener("abort", onAbort);
        };
      });

      try {
        const { payload } = await Promise.race([
          jwtVerify(token, options.getKey, verifyOptions),
          cancellation,
        ]);
        return toPrincipal(payload);
      } catch (error) {
        if (isInvalidCredential(error)) return null;
        // Re-thrown without the original error: its message may name the key
        // source, the provider response, or the rejected token.
        throw new AccessTokenVerificationUnavailableError();
      } finally {
        removeAbortListener();
      }
    },
  };
}
