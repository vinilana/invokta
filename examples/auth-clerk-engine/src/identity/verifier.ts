import {
  createRemoteJWKSet,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

const JWKS_PATH = "/.well-known/jwks.json";
const SIGNING_ALGORITHMS = ["RS256"] as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MAX_AGE_MS = 600_000;
const COMPACT_JWS = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * The verified subset of a Clerk session token that this engine is allowed to
 * carry forward. `sub` is the Clerk user ID and `sid` the session ID. The
 * organization membership comes from the v2 compact `o` object (`o.id`,
 * `o.rol`) with a fallback to the v1 `org_id`/`org_role` claims Clerk
 * deprecated on 2025-04-14; the role is normalized to the v2 form without the
 * `org:` prefix so access rules see one stable shape. Everything else in the
 * token stays at this boundary.
 */
export interface ClerkSessionClaims {
  readonly sub: string;
  readonly sid?: string;
  readonly org_id?: string;
  readonly org_role?: string;
}

export interface ClerkSessionVerifierOptions {
  /**
   * The instance Frontend API URL, which is also the `iss` claim Clerk puts in
   * its session tokens: `https://<slug>.clerk.accounts.dev` in development and
   * `https://clerk.<your-domain>.com` for a production custom domain.
   */
  readonly frontendApiUrl: string;
  /**
   * Origins allowed to hold a token for this engine. Clerk recommends an
   * explicit authorized-party allowlist, because a token minted for another
   * origin of the same instance is otherwise a valid credential here.
   */
  readonly authorizedParties: ReadonlyArray<string>;
  /**
   * When true, a token WITHOUT an `azp` claim is rejected too. Session tokens
   * carry `azp`, but custom JWT templates and machine tokens may not — with
   * the default `false` those pass the allowlist unchecked, mirroring Clerk
   * SDK semantics. Enable this when every legitimate caller is a session.
   */
  readonly requireAuthorizedParty?: boolean;
  /**
   * Key resolution. Production wiring passes `createClerkRemoteKeys(...)`;
   * tests pass `createLocalJWKSet(...)` so signature verification stays real
   * without any network access.
   */
  readonly keys: JWTVerifyGetKey;
  readonly timeoutMs?: number;
  readonly clockToleranceSeconds?: number;
}

export interface ClerkSessionVerifier {
  verify(
    token: string,
    options: { readonly signal: AbortSignal },
  ): Promise<ClerkSessionClaims | null>;
}

/**
 * Raised only when the verification itself could not complete, which the MCP
 * HTTP adapter turns into a sanitized HTTP 500. It carries no message detail,
 * no cause, and no claim set: a jose claim-validation failure holds the decoded
 * payload, and none of it may reach a log.
 */
export class ClerkVerificationUnavailableError extends Error {
  constructor() {
    super("Clerk session verification is unavailable.");
    this.name = "ClerkVerificationUnavailableError";
  }
}

/**
 * These jose failures mean "this credential is invalid", never "try again".
 * `JWKSMultipleMatchingKeys` is deliberately absent: an ambiguous key set is
 * the instance's key-publication problem, not evidence against the
 * credential, so it surfaces as an infrastructure failure (500) instead of
 * silently rejecting legitimate tokens during a kid-less key rotation.
 */
const INVALID_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  errors.JOSEAlgNotAllowed.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWSInvalid.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JWTClaimValidationFailed.code,
  errors.JWTExpired.code,
  errors.JWTInvalid.code,
]);

function isInvalidCredential(error: unknown): boolean {
  return (
    error instanceof errors.JOSEError &&
    INVALID_CREDENTIAL_CODES.has(error.code)
  );
}

/** The public JWKS of a Clerk instance, derived from its Frontend API URL. */
export function clerkJwksUrl(frontendApiUrl: string): URL {
  const base = new URL(frontendApiUrl);
  if (base.protocol !== "https:") {
    throw new Error("The Clerk Frontend API URL must use HTTPS.");
  }
  return new URL(JWKS_PATH, base.origin);
}

/** Production key resolution: the instance JWKS, cached and time-bounded. */
export function createClerkRemoteKeys(
  frontendApiUrl: string,
  options: { readonly timeoutMs?: number } = {},
): JWTVerifyGetKey {
  return createRemoteJWKSet(clerkJwksUrl(frontendApiUrl), {
    timeoutDuration: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
  });
}

function isAbsentOrNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value !== "");
}

/**
 * Reads the organization membership. Session token v2 (the current standard)
 * carries it in the compact top-level `o` object; the v1 `org_id`/`org_role`
 * claims, deprecated on 2025-04-14, are still read as a fallback for
 * unmigrated instances. The v1 role's `org:` prefix is stripped so both
 * versions produce the v2 shape. Malformed organization data fails closed.
 */
function readOrganization(
  payload: JWTPayload,
): { readonly orgId?: string; readonly orgRole?: string } | null {
  const compact = payload.o;
  if (compact !== undefined) {
    if (typeof compact !== "object" || compact === null) return null;
    const { id, rol } = compact as {
      readonly id?: unknown;
      readonly rol?: unknown;
    };
    if (!isAbsentOrNonEmptyString(id)) return null;
    if (!isAbsentOrNonEmptyString(rol)) return null;
    return {
      ...(id === undefined ? {} : { orgId: id }),
      ...(rol === undefined ? {} : { orgRole: rol }),
    };
  }

  const { org_id: orgId, org_role: orgRole } = payload;
  if (!isAbsentOrNonEmptyString(orgId)) return null;
  if (!isAbsentOrNonEmptyString(orgRole)) return null;
  return {
    ...(orgId === undefined ? {} : { orgId }),
    ...(orgRole === undefined
      ? {}
      : { orgRole: orgRole.replace(/^org:/u, "") }),
  };
}

/**
 * Reads the claims this engine trusts, enforcing the session status and the
 * authorized party. A v2 `sts` other than `active` — Clerk mints `pending`
 * for a user who signed in but has unfinished session tasks such as MFA
 * enrollment or a mandatory organization selection — is rejected, matching
 * the signed-out treatment Clerk's own SDKs apply by default. `azp` is absent
 * from custom JWT templates and machine tokens, so by default it is checked
 * when present; `requireAuthorizedParty` closes that path too.
 */
function readSessionClaims(
  payload: JWTPayload,
  authorizedParties: ReadonlyArray<string>,
  requireAuthorizedParty: boolean,
): ClerkSessionClaims | null {
  const { azp, sid, sts } = payload;

  if (sts !== undefined && sts !== "active") return null;

  if (azp === undefined) {
    if (requireAuthorizedParty) return null;
  } else {
    if (typeof azp !== "string" || azp === "") return null;
    if (!authorizedParties.includes(azp)) return null;
  }

  const subject = payload.sub;
  if (typeof subject !== "string" || subject === "") return null;
  if (!isAbsentOrNonEmptyString(sid)) return null;
  const organization = readOrganization(payload);
  if (organization === null) return null;

  return {
    sub: subject,
    ...(sid === undefined ? {} : { sid }),
    ...(organization.orgId === undefined ? {} : { org_id: organization.orgId }),
    ...(organization.orgRole === undefined
      ? {}
      : { org_role: organization.orgRole }),
  };
}

/** Rejects `work` as soon as `signal` aborts, without leaving it unhandled. */
function settleWith<Value>(
  signal: AbortSignal,
  work: Promise<Value>,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Verifies a Clerk session token against the instance JWKS: RS256 signature,
 * `iss` equal to the Frontend API URL, `exp` and `nbf` within the configured
 * clock tolerance, and `azp` inside the authorized-party allowlist.
 */
export function createClerkSessionVerifier(
  options: ClerkSessionVerifierOptions,
): ClerkSessionVerifier {
  const issuer = new URL(options.frontendApiUrl).origin;
  const authorizedParties = Object.freeze([...options.authorizedParties]);
  const requireAuthorizedParty = options.requireAuthorizedParty ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clockTolerance =
    options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const keys = options.keys;

  return {
    async verify(token, { signal }) {
      if (!COMPACT_JWS.test(token)) return null;

      // The verifier owns its own bound: the caller's signal cancels it, and
      // its own timeout stops a stalled key fetch from holding the request.
      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      let payload: JWTPayload;
      try {
        const verified = await settleWith(
          deadline,
          jwtVerify(token, keys, {
            issuer,
            algorithms: [...SIGNING_ALGORITHMS],
            // Clerk session tokens carry no aud; azp is the party binding.
            // These claims are always minted, so a signed token missing one
            // — notably exp — must not become a permanent credential.
            requiredClaims: ["sub", "iss", "exp"],
            clockTolerance,
          }),
        );
        payload = verified.payload;
      } catch (error) {
        if (isInvalidCredential(error)) return null;
        throw new ClerkVerificationUnavailableError();
      }

      return readSessionClaims(
        payload,
        authorizedParties,
        requireAuthorizedParty,
      );
    },
  };
}
