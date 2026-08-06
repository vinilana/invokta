import {
  createRemoteJWKSet,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

/**
 * Amazon Cognito user pool ACCESS token verification.
 *
 * This module is composition-root code, not a framework abstraction. It turns a
 * bearer credential into the minimum set of verified claims the engine needs,
 * and it never returns the token, the raw payload, or an SDK object.
 *
 * Cognito specifics this verifier enforces, per the AWS "Verifying JSON web
 * tokens" guide:
 *
 * - the issuer is `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>`;
 * - the signing keys are published at `<issuer>/.well-known/jwks.json` and are
 *   RS256 only;
 * - an access token carries NO `aud` claim, so the app client is validated
 *   through the `client_id` claim instead;
 * - `token_use` must be `access`; an id token presented to an API is rejected.
 */

/** The verified, authorization-relevant subset of a Cognito access token. */
export interface CognitoVerifiedIdentity {
  readonly subject: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly groups: ReadonlyArray<string>;
}

export interface CognitoAccessTokenVerifier {
  verify(
    token: string,
    options: { readonly signal: AbortSignal },
  ): Promise<CognitoVerifiedIdentity | null>;
}

export interface CognitoVerifierConfig {
  /** AWS region of the user pool, for example `us-east-1`. */
  readonly region: string;
  /** User pool id, for example `us-east-1_ExamplePool`. */
  readonly userPoolId: string;
  /** App client ids allowed to call this engine (the `client_id` claim). */
  readonly appClientIds: ReadonlyArray<string>;
  /** Bound for the JWKS fetch of the default remote key resolver. */
  readonly jwksTimeoutMs?: number;
  /**
   * Key resolution. Production wiring omits it and gets a cached remote JWKS.
   * Tests inject `createLocalJWKSet(...)` so signature verification is real
   * without any network access.
   */
  readonly getKey?: JWTVerifyGetKey;
}

/**
 * Raised when the verification path itself could not complete: JWKS fetch
 * timeout, transport failure, or a cancelled request. The message is a single
 * stable sentence so no credential material can reach a log or an HTTP 500
 * body. An invalid credential never produces this error; it produces `null`.
 */
export class CognitoVerificationUnavailableError extends Error {
  constructor() {
    super("Cognito token verification is unavailable.");
    this.name = "CognitoVerificationUnavailableError";
  }
}

const DEFAULT_JWKS_TIMEOUT_MS = 3_000;
const SIGNING_ALGORITHM = "RS256";
const ACCESS_TOKEN_USE = "access";
const GROUPS_CLAIM = "cognito:groups";

export function cognitoIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

export function cognitoJwksUri(region: string, userPoolId: string): URL {
  return new URL(`${cognitoIssuer(region, userPoolId)}/.well-known/jwks.json`);
}

/**
 * jose reports an unusable credential with a dedicated error class. Anything
 * else — a JWKS timeout, a transport error, a malformed JWKS document, an
 * abort — is infrastructure and must not be reported as "invalid credential".
 */
// An ambiguous key set (JWKSMultipleMatchingKeys) is deliberately not in this
// list: two same-algorithm keys published without kid headers is the pool's
// key-publication problem, not evidence against the credential, so it surfaces
// as an infrastructure failure (500) instead of silently rejecting legitimate
// tokens during a kid-less key rotation.
function isInvalidCredential(error: unknown): boolean {
  return (
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTExpired ||
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JWKSNoMatchingKey
  );
}

/** Bounds the verification on the caller's signal without leaking a listener. */
async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new CognitoVerificationUnavailableError();

  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new CognitoVerificationUnavailableError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function readStringClaim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Cognito writes OAuth 2.0 scopes as one space-delimited string. */
function readScopes(payload: JWTPayload): ReadonlyArray<string> | null {
  const value = payload.scope;
  if (value === undefined) return [];
  if (typeof value !== "string") return null;
  return value.split(" ").filter((scope) => scope !== "");
}

/** Cognito writes group membership as a JSON array of strings. */
function readGroups(payload: JWTPayload): ReadonlyArray<string> | null {
  const value = payload[GROUPS_CLAIM];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.every((group) => typeof group === "string" && group !== "")
    ? (value as ReadonlyArray<string>)
    : null;
}

function toIdentity(
  payload: JWTPayload,
  appClientIds: ReadonlyArray<string>,
): CognitoVerifiedIdentity | null {
  if (payload.token_use !== ACCESS_TOKEN_USE) return null;

  const subject = readStringClaim(payload, "sub");
  if (subject === null) return null;

  // An access token has no `aud` claim, so the app client is authorized here.
  const clientId = readStringClaim(payload, "client_id");
  if (clientId === null || !appClientIds.includes(clientId)) return null;

  const scopes = readScopes(payload);
  const groups = readGroups(payload);
  if (scopes === null || groups === null) return null;

  return { subject, clientId, scopes, groups };
}

export function createCognitoVerifier(
  config: CognitoVerifierConfig,
): CognitoAccessTokenVerifier {
  if (config.region === "" || config.userPoolId === "") {
    throw new Error("A Cognito region and user pool id are required.");
  }
  if (config.appClientIds.length === 0) {
    throw new Error("At least one Cognito app client id is required.");
  }

  const issuer = cognitoIssuer(config.region, config.userPoolId);
  const appClientIds = [...config.appClientIds];
  const getKey: JWTVerifyGetKey =
    config.getKey ??
    createRemoteJWKSet(cognitoJwksUri(config.region, config.userPoolId), {
      timeoutDuration: config.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
    });

  return {
    async verify(token, options) {
      let payload: JWTPayload;
      try {
        const verified = await withAbort(
          jwtVerify(token, getKey, {
            issuer,
            algorithms: [SIGNING_ALGORITHM],
            // Cognito access tokens carry no aud claim; client_id is checked
            // in toIdentity instead. The other claims are always minted, so a
            // signed token missing one is not a Cognito access token.
            requiredClaims: ["sub", "iss", "exp"],
          }),
          options.signal,
        );
        payload = verified.payload;
      } catch (error) {
        if (isInvalidCredential(error)) return null;
        // Nothing from the failure is re-exported: no message, no cause.
        throw new CognitoVerificationUnavailableError();
      }
      return toIdentity(payload, appClientIds);
    },
  };
}
