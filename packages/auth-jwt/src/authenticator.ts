import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
  jwtVerify,
} from "jose";

const SIGNATURE_ALGORITHMS = Object.freeze([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
] as const);

/**
 * An asymmetric JWS algorithm the authenticator can verify. `none` and the
 * shared-secret `HS*` family are deliberately absent: a Resource Server that
 * can verify a shared-secret token can also mint one.
 */
export type JwtSignatureAlgorithm = (typeof SIGNATURE_ALGORITHMS)[number];

const DEFAULT_MAX_TOKEN_LENGTH = 8_192;
const MAX_TOKEN_LENGTH_LIMIT = 16_384;
const MAX_CLOCK_TOLERANCE_SECONDS = 300;
const JWKS_TIMEOUT_MS = 5_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MAX_AGE_MS = 600_000;
const BEARER_PREFIX = "bearer ";
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);
const PRIVATE_KEY_MEMBERS = ["d", "k", "priv"] as const;

/**
 * jose failures that prove the presented credential is unacceptable. Every
 * other failure (a JWKS timeout, transport error, unusable key set, ambiguous
 * key set, or cancellation) means the check did not complete.
 */
const INVALID_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWSInvalid.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JWTClaimValidationFailed.code,
  errors.JWTExpired.code,
  errors.JWTInvalid.code,
]);

/** The header view the authenticator reads. */
export interface JwtBearerHeaders {
  get(name: string): string | null;
}

/**
 * The request view the authenticator reads. It is structural, so the MCP HTTP
 * authentication request, a Web `Request`, or any adapter exposing the same
 * header lookup fits without conversion.
 */
export interface JwtBearerRequest {
  readonly headers: JwtBearerHeaders;
  readonly signal?: AbortSignal;
}

/** Structurally identical to the `Principal` defined by `@invokta/core`. */
export interface JwtPrincipal {
  readonly id: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** A claim set whose signature, issuer, audience, and lifetime verified. */
export type VerifiedJwtClaims = Readonly<JWTPayload>;

/**
 * Maps verified claims to a principal, or `null` to reject the credential. It
 * never receives the raw token.
 */
export type JwtPrincipalMapper = (
  claims: VerifiedJwtClaims,
) => JwtPrincipal | null;

/**
 * Resolves a principal for a verified bearer token, `null` for a missing or
 * invalid credential, and rejects only when verification cannot complete.
 */
export type JwtBearerAuthenticator = (
  request: JwtBearerRequest,
) => Promise<JwtPrincipal | null>;

/** Exactly one key source: a remote JWKS URL or a local key set. */
export type JwtKeySource =
  | {
      /**
       * HTTPS JWKS URL, or loopback HTTP for local development. The key set is
       * fetched on first use with a 5 second timeout, cached for 10 minutes,
       * and refetched for an unknown key at most once every 30 seconds.
       */
      readonly jwksUrl: string | URL;
      readonly jwks?: never;
    }
  | {
      /** Public keys only; for tests, offline use, or pinned keys. */
      readonly jwks: JSONWebKeySet;
      readonly jwksUrl?: never;
    };

export interface JwtBearerPolicyOptions {
  /** The exact `iss` value to accept. */
  readonly issuer: string;
  /** The accepted `aud` value or values; the token must carry at least one. */
  readonly audience: string | ReadonlyArray<string>;
  /** Required, non-empty signature algorithm allowlist. */
  readonly algorithms: ReadonlyArray<JwtSignatureAlgorithm>;
  /** Clock skew allowance for `exp` and `nbf`: an integer from 0 to 300. */
  readonly clockToleranceSeconds?: number;
  /**
   * Scopes the space-delimited `scope` claim must grant. A token missing one
   * resolves `null`; pair the list with the MCP `challengeScopes` so the 401
   * challenge names what to request.
   */
  readonly requiredScopes?: ReadonlyArray<string>;
  /** Maximum token length in characters: 8,192 by default, at most 16,384. */
  readonly maxTokenLength?: number;
  /** Claims-to-principal mapping. Defaults to {@link defaultJwtPrincipal}. */
  readonly principal?: JwtPrincipalMapper;
}

export type JwtBearerAuthenticatorOptions = JwtBearerPolicyOptions &
  JwtKeySource;

/**
 * Signals that verification could not complete: the key set was unreachable,
 * unusable, or ambiguous, or the request was cancelled. The message is fixed
 * and no cause is attached, so no token, URL, or provider response can reach a
 * response or a log through it.
 */
export class JwtVerificationUnavailableError extends Error {
  constructor() {
    super("JWT bearer verification is unavailable.");
    this.name = "JwtVerificationUnavailableError";
  }
}

/** Reports whether a value names a supported signature algorithm. */
export function isJwtSignatureAlgorithm(
  value: unknown,
): value is JwtSignatureAlgorithm {
  return (
    typeof value === "string" &&
    (SIGNATURE_ALGORITHMS as ReadonlyArray<string>).includes(value)
  );
}

function parseScopeClaim(value: unknown): ReadonlyArray<string> {
  if (typeof value !== "string") return Object.freeze([]);
  return Object.freeze([
    ...new Set(value.split(" ").filter((scope) => scope !== "")),
  ]);
}

/**
 * The default mapping: `sub` becomes the id, and the `scope`, `iss`, and
 * `client_id` claims become `attributes.scopes`, `attributes.issuer`, and
 * `attributes.clientId`. Every other claim stays out of the principal.
 */
export function defaultJwtPrincipal(
  claims: VerifiedJwtClaims,
): JwtPrincipal | null {
  const subject = claims.sub;
  if (typeof subject !== "string" || subject.trim() === "") return null;
  const issuer = claims.iss;
  if (typeof issuer !== "string" || issuer === "") return null;
  const clientId = claims.client_id;

  return Object.freeze({
    id: subject,
    attributes: Object.freeze({
      scopes: parseScopeClaim(claims.scope),
      issuer,
      ...(typeof clientId === "string" && clientId !== "" ? { clientId } : {}),
    }),
  });
}

function nonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new TypeError(message);
  }
  return value;
}

function snapshotAudience(value: unknown): string | string[] {
  const message =
    "audience must be a non-empty string or a non-empty list of them.";
  if (typeof value === "string") return nonEmptyString(value, message);
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(message);
  }
  return value.map((entry) => nonEmptyString(entry, message));
}

function snapshotAlgorithms(value: unknown): JwtSignatureAlgorithm[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("algorithms must list at least one algorithm.");
  }
  const algorithms: JwtSignatureAlgorithm[] = [];
  for (const algorithm of value) {
    if (!isJwtSignatureAlgorithm(algorithm)) {
      throw new TypeError(
        `algorithms may contain only ${SIGNATURE_ALGORITHMS.join(", ")}.`,
      );
    }
    if (algorithms.includes(algorithm)) {
      throw new TypeError("algorithms must not contain duplicates.");
    }
    algorithms.push(algorithm);
  }
  return algorithms;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  message: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(message);
  }
  return value;
}

function snapshotRequiredScopes(value: unknown): ReadonlyArray<string> {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("requiredScopes must list at least one scope.");
  }
  const scopes: string[] = [];
  for (const scope of value) {
    if (typeof scope !== "string" || !SCOPE_TOKEN.test(scope)) {
      throw new TypeError(
        "requiredScopes must contain only RFC 6749 scope tokens.",
      );
    }
    if (scopes.includes(scope)) {
      throw new TypeError("requiredScopes must not contain duplicates.");
    }
    scopes.push(scope);
  }
  return Object.freeze(scopes);
}

function snapshotJwksUrl(value: unknown): URL {
  const message =
    "jwksUrl must be an absolute HTTPS URL, or loopback HTTP for development, without credentials or a fragment.";
  if (typeof value !== "string" && !(value instanceof URL)) {
    throw new TypeError(message);
  }
  let url: URL;
  try {
    url = new URL(typeof value === "string" ? value : value.href);
  } catch {
    throw new TypeError(message);
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
  if (!secure || url.username !== "" || url.password !== "" || url.hash) {
    throw new TypeError(message);
  }
  return url;
}

function createLocalKeySet(value: unknown): JWTVerifyGetKey {
  const message = "jwks must be a JSON Web Key Set of public keys.";
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray((value as { readonly keys?: unknown }).keys)
  ) {
    throw new TypeError(message);
  }
  const { keys } = value as { readonly keys: ReadonlyArray<unknown> };
  for (const key of keys) {
    if (
      key === null ||
      typeof key !== "object" ||
      PRIVATE_KEY_MEMBERS.some((member) => member in key)
    ) {
      throw new TypeError(message);
    }
  }
  try {
    // jose snapshots the set, so later mutation of the caller's object has no
    // effect on verification.
    return createLocalJWKSet(value as JSONWebKeySet);
  } catch {
    throw new TypeError(message);
  }
}

function createKeySource(options: JwtKeySource): JWTVerifyGetKey {
  const remote = options.jwksUrl !== undefined;
  const local = options.jwks !== undefined;
  if (remote === local) {
    throw new TypeError("Configure exactly one key source: jwksUrl or jwks.");
  }
  if (local) return createLocalKeySet(options.jwks);
  return createRemoteJWKSet(snapshotJwksUrl(options.jwksUrl), {
    timeoutDuration: JWKS_TIMEOUT_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
  });
}

/**
 * Returns the token of a strict `Bearer <token>` credential: a case-insensitive
 * scheme, exactly one space, and a compact JWS of bounded length. Anything else
 * is treated as no credential.
 */
function readBearerToken(
  headers: JwtBearerHeaders,
  maxTokenLength: number,
): string | null {
  const authorization = headers.get("authorization");
  if (
    typeof authorization !== "string" ||
    authorization.length > BEARER_PREFIX.length + maxTokenLength ||
    authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX
  ) {
    return null;
  }
  const token = authorization.slice(BEARER_PREFIX.length);
  return COMPACT_JWS.test(token) ? token : null;
}

function isInvalidCredential(error: unknown): boolean {
  return (
    error instanceof errors.JOSEError &&
    INVALID_CREDENTIAL_CODES.has(error.code)
  );
}

/**
 * Settles with the work, or rejects as soon as the request is cancelled. jose
 * accepts no per-call signal, so a key-set fetch already in flight finishes in
 * the background within its own timeout and refreshes the shared cache.
 */
async function settleWithin<Value>(
  work: Promise<Value>,
  signal: AbortSignal | undefined,
): Promise<Value> {
  if (signal === undefined) return work;
  let stopListening = (): void => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new JwtVerificationUnavailableError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    stopListening = (): void => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    stopListening();
  }
}

function isPrincipal(value: unknown): value is JwtPrincipal {
  if (value === null || typeof value !== "object") return false;
  const { id, attributes } = value as {
    readonly id?: unknown;
    readonly attributes?: unknown;
  };
  if (typeof id !== "string" || id === "") return false;
  return (
    attributes === undefined ||
    (attributes !== null &&
      typeof attributes === "object" &&
      !Array.isArray(attributes))
  );
}

/**
 * Creates a JWT bearer authenticator usable directly as the `authenticate`
 * hook of `serveMcpHttp` or any adapter with the same request view.
 *
 * Configuration is validated and snapshotted here; a remote key set is not
 * fetched until the first credential arrives. Each call resolves:
 *
 * - a principal for a token whose signature, algorithm, issuer, audience,
 *   lifetime, subject, and required scopes all verified;
 * - `null` for a missing, malformed, oversized, or invalid credential, without
 *   revealing why;
 * - a rejected {@link JwtVerificationUnavailableError} when the check could not
 *   complete, which the MCP HTTP adapter answers with a sanitized 500.
 */
export function createJwtBearerAuthenticator(
  options: JwtBearerAuthenticatorOptions,
): JwtBearerAuthenticator {
  if (options === null || typeof options !== "object") {
    throw new TypeError("JWT bearer authenticator options must be an object.");
  }
  const issuer = nonEmptyString(
    options.issuer,
    "issuer must be a non-empty string without surrounding whitespace.",
  );
  const audience = snapshotAudience(options.audience);
  const algorithms = snapshotAlgorithms(options.algorithms);
  const clockTolerance = boundedInteger(
    options.clockToleranceSeconds,
    0,
    0,
    MAX_CLOCK_TOLERANCE_SECONDS,
    `clockToleranceSeconds must be an integer from 0 to ${MAX_CLOCK_TOLERANCE_SECONDS}.`,
  );
  const requiredScopes = snapshotRequiredScopes(options.requiredScopes);
  const maxTokenLength = boundedInteger(
    options.maxTokenLength,
    DEFAULT_MAX_TOKEN_LENGTH,
    1,
    MAX_TOKEN_LENGTH_LIMIT,
    `maxTokenLength must be an integer from 1 to ${MAX_TOKEN_LENGTH_LIMIT}.`,
  );
  const mapPrincipal = options.principal ?? defaultJwtPrincipal;
  if (typeof mapPrincipal !== "function") {
    throw new TypeError("principal must be a function.");
  }
  const getKey = createKeySource(options);
  const verifyOptions: JWTVerifyOptions = {
    issuer,
    audience,
    algorithms,
    clockTolerance,
    requiredClaims: ["sub", "exp"],
  };

  return async (request) => {
    const signal = request.signal;
    if (signal?.aborted === true) throw new JwtVerificationUnavailableError();

    const token = readBearerToken(request.headers, maxTokenLength);
    if (token === null) return null;

    let claims: JWTPayload;
    try {
      ({ payload: claims } = await settleWithin(
        jwtVerify(token, getKey, verifyOptions),
        signal,
      ));
    } catch (error) {
      if (isInvalidCredential(error)) return null;
      // The original error is dropped: it may name the key-set URL, quote the
      // provider's response, or describe the token.
      throw new JwtVerificationUnavailableError();
    }

    const granted = parseScopeClaim(claims.scope);
    if (!requiredScopes.every((scope) => granted.includes(scope))) return null;

    const principal = mapPrincipal(claims);
    return isPrincipal(principal) ? principal : null;
  };
}
