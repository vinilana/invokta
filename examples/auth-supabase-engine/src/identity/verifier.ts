import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

import { type SupabaseIdentity, toSupabaseIdentity } from "./principal.js";

/**
 * Supabase Auth signs project access tokens with the project's JWT signing
 * key. With asymmetric signing keys enabled the public half is published at
 * `<issuer>/.well-known/jwks.json`, so a Resource Server verifies a token
 * locally instead of calling the Auth server for every request.
 *
 * Legacy projects still sign with the shared HS256 JWT secret. This verifier
 * deliberately refuses HS256: a secret that can verify a token can also mint
 * one, which is not a property a Resource Server boundary should hold.
 */
const SUPABASE_ASYMMETRIC_ALGORITHMS = ["ES256", "RS256"] as const;

const DEFAULT_AUDIENCE = "authenticated";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;

/**
 * Verification failures jose reports for the credential itself. Every one of
 * them means "this token is not acceptable", never "the check could not run".
 */
const INVALID_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

/**
 * Raised when the credential could not be checked at all: the JWKS endpoint is
 * unreachable, the deadline passed, or the request was aborted. The MCP HTTP
 * adapter turns a thrown hook into a sanitized HTTP 500, which is the honest
 * answer — the request was not proven invalid.
 *
 * The message is a fixed sentence and no cause is attached, so nothing from
 * the failed call, including token material, can reach a log.
 */
export class SupabaseVerificationUnavailableError extends Error {
  constructor() {
    super("Supabase access token verification is unavailable.");
    this.name = "SupabaseVerificationUnavailableError";
  }
}

export interface SupabaseAccessTokenVerifier {
  verify(
    token: string,
    options: { readonly signal: AbortSignal },
  ): Promise<SupabaseIdentity | null>;
}

export interface SupabaseVerifierOptions {
  /** The project issuer, `https://<project-ref>.supabase.co/auth/v1`. */
  readonly issuer: string;
  /**
   * Key resolution. Production wiring passes `createRemoteJWKSet(...)`; tests
   * pass `createLocalJWKSet(...)` so signature verification stays real and
   * offline.
   */
  readonly keys: JWTVerifyGetKey;
  /** Supabase issues "authenticated" for users and "anon" for anonymous ones. */
  readonly audience?: string;
  /** Deadline for one verification, including key resolution. */
  readonly timeoutMs?: number;
  readonly clockToleranceSeconds?: number;
}

export interface SupabaseProjectVerifierOptions {
  /** The project URL, `https://<project-ref>.supabase.co`. */
  readonly projectUrl: string;
  readonly audience?: string;
  readonly timeoutMs?: number;
  readonly clockToleranceSeconds?: number;
}

function projectOrigin(projectUrl: string): string {
  let url: URL;
  try {
    url = new URL(projectUrl);
  } catch {
    throw new TypeError("The Supabase project URL is not a valid URL.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError(
      "The Supabase project URL must use HTTPS, except for a local Supabase stack on loopback.",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** `https://<project-ref>.supabase.co` -> `https://<project-ref>.supabase.co/auth/v1`. */
export function supabaseIssuer(projectUrl: string): string {
  return `${projectOrigin(projectUrl)}/auth/v1`;
}

/** The project's published JWKS document for asymmetric signing keys. */
export function supabaseJwksUrl(projectUrl: string): string {
  return `${supabaseIssuer(projectUrl)}/.well-known/jwks.json`;
}

function isInvalidCredential(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && INVALID_CREDENTIAL_CODES.has(code);
}

/**
 * Applies the request signal and the verifier's own deadline to work that
 * cannot take an AbortSignal itself.
 */
async function withDeadline<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Result> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  if (deadline.aborted) throw new SupabaseVerificationUnavailableError();

  const onAbort = { listener: (): void => undefined };
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort.listener = () => {
      reject(new SupabaseVerificationUnavailableError());
    };
    deadline.addEventListener("abort", onAbort.listener, { once: true });
  });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    deadline.removeEventListener("abort", onAbort.listener);
  }
}

/**
 * Builds a verifier around injectable key resolution. Verification is the only
 * place the raw token is read.
 */
export function createSupabaseVerifier(
  options: SupabaseVerifierOptions,
): SupabaseAccessTokenVerifier {
  const issuer = options.issuer;
  const audience = options.audience ?? DEFAULT_AUDIENCE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clockTolerance =
    options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;

  return {
    async verify(token, { signal }) {
      if (token === "") return null;

      try {
        const { payload } = await withDeadline(
          jwtVerify(token, options.keys, {
            issuer,
            audience,
            algorithms: [...SUPABASE_ASYMMETRIC_ALGORITHMS],
            clockTolerance,
          }),
          signal,
          timeoutMs,
        );
        return toSupabaseIdentity(payload);
      } catch (error) {
        if (isInvalidCredential(error)) return null;
        // Anything else — DNS, TLS, timeout, abort, a malformed JWKS — is an
        // infrastructure failure. It is rethrown without its cause.
        throw new SupabaseVerificationUnavailableError();
      }
    },
  };
}

/**
 * Production wiring: resolve keys from the project's published JWKS. jose
 * caches the document and bounds its own fetch, and Supabase serves it from
 * the edge cache for ten minutes.
 */
export function createSupabaseProjectVerifier(
  options: SupabaseProjectVerifierOptions,
): SupabaseAccessTokenVerifier {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keys = createRemoteJWKSet(
    new URL(supabaseJwksUrl(options.projectUrl)),
    {
      timeoutDuration: timeoutMs,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    },
  );

  return createSupabaseVerifier({
    issuer: supabaseIssuer(options.projectUrl),
    keys,
    timeoutMs,
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.clockToleranceSeconds === undefined
      ? {}
      : { clockToleranceSeconds: options.clockToleranceSeconds }),
  });
}
