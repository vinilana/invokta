import {
  createRemoteJWKSet,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";

/**
 * The WorkOS AuthKit access-token claims this engine trusts.
 *
 * WorkOS documents the access token as a JWT carrying `sub` (the WorkOS user
 * id), `sid` (the session id), `org_id` (the organization selected at sign-in,
 * when applicable), `role` (the role of the selected organization membership),
 * `permissions` (the permissions of that role), plus the standard `iss`, `iat`,
 * and `exp` claims.
 */
export interface WorkOsAccessTokenClaims {
  readonly sub: string;
  readonly sid?: string;
  readonly org_id?: string;
  readonly role?: string;
  readonly permissions?: ReadonlyArray<string>;
}

export interface WorkOsAccessTokenVerifier {
  verify(
    token: string,
    options: { readonly signal: AbortSignal },
  ): Promise<WorkOsAccessTokenClaims | null>;
}

export interface WorkOsVerifierOptions {
  /** The WorkOS client id whose JWKS signs this environment's tokens. */
  readonly clientId: string;
  /**
   * Expected `iss`. WorkOS issues `https://api.workos.com/`, or the custom
   * auth domain configured for the environment.
   */
  readonly issuer?: string;
  /**
   * Expected `aud`. Configure it when AuthKit is registered as the
   * authorization server for this resource, so tokens minted for another
   * resource cannot be replayed here.
   */
  readonly audience?: string;
  /** Overrides the derived JWKS endpoint, for a custom auth domain. */
  readonly jwksUrl?: URL | string;
  /**
   * Key resolution. Production wiring resolves the WorkOS JWKS remotely;
   * tests inject `createLocalJWKSet` so verification stays offline.
   */
  readonly keys?: JWTVerifyGetKey;
  readonly algorithms?: ReadonlyArray<string>;
  readonly clockToleranceSeconds?: number;
  readonly timeoutMs?: number;
}

/** Raised only when the check could not complete, never for a bad credential. */
export class WorkOsVerificationUnavailableError extends Error {
  constructor() {
    super("WorkOS access-token verification is unavailable.");
    this.name = "WorkOsVerificationUnavailableError";
  }
}

export const WORKOS_DEFAULT_AUTH_DOMAIN = "https://api.workos.com";
export const WORKOS_DEFAULT_ISSUER = "https://api.workos.com/";

const DEFAULT_ALGORITHMS = ["RS256"] as const;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The WorkOS signing JWKS is scoped to one client:
 * `https://api.workos.com/sso/jwks/<clientId>`, or the same path on the
 * environment's custom auth domain.
 */
export function workOsJwksUrl(
  clientId: string,
  authDomain: string = WORKOS_DEFAULT_AUTH_DOMAIN,
): URL {
  if (clientId.trim() === "") {
    throw new Error("A WorkOS client id is required to derive the JWKS URL.");
  }
  const base = authDomain.endsWith("/") ? authDomain : `${authDomain}/`;
  return new URL(`sso/jwks/${encodeURIComponent(clientId)}`, base);
}

/**
 * The OAuth JWKS the environment's AuthKit domain serves for MCP OAuth
 * tokens: `https://<environment>.authkit.app/oauth2/jwks`. These tokens are a
 * different flavor from AuthKit session tokens — their issuer is the AuthKit
 * domain itself and their `aud` is bound to the registered resource — so they
 * are signed by a different key set than {@link workOsJwksUrl} serves.
 */
export function workOsAuthKitJwksUrl(authKitDomain: string): URL {
  let url: URL;
  try {
    url = new URL(authKitDomain);
  } catch {
    throw new Error("The AuthKit domain is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("The AuthKit domain must use HTTPS.");
  }
  return new URL(`${url.origin}/oauth2/jwks`);
}

/** A claim value the engine keeps only when it has the documented shape. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item !== "")
    ? Object.freeze([...(value as ReadonlyArray<string>)])
    : undefined;
}

/**
 * Narrows a verified payload to the documented WorkOS claims. Everything else
 * the token carries is dropped here, so it can never reach a principal.
 */
function readClaims(payload: JWTPayload): WorkOsAccessTokenClaims | null {
  const sub = readString(payload.sub);
  if (sub === undefined) return null;

  const sid = readString(payload.sid);
  const organizationId = readString(payload.org_id);
  const role = readString(payload.role);
  const permissions = readStringArray(payload.permissions);

  return Object.freeze({
    sub,
    ...(sid === undefined ? {} : { sid }),
    ...(organizationId === undefined ? {} : { org_id: organizationId }),
    ...(role === undefined ? {} : { role }),
    ...(permissions === undefined ? {} : { permissions }),
  });
}

/**
 * True for every failure that proves the credential itself is unusable. Any
 * other failure is treated as infrastructure, so an unknown fault can never be
 * reported to the caller as an authentication decision.
 *
 * `JWKSMultipleMatchingKeys` is deliberately absent: an ambiguous key set is
 * the environment's key-publication problem, not evidence against the
 * credential, so it surfaces as an infrastructure failure (500) instead of
 * silently rejecting legitimate tokens during a kid-less key rotation.
 */
function isInvalidCredential(error: unknown): boolean {
  return (
    error instanceof errors.JWTExpired ||
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JWKSNoMatchingKey
  );
}

/** Settles as soon as the deadline aborts, whatever the operation still does. */
async function withDeadline<Value>(
  operation: Promise<Value>,
  deadline: AbortSignal,
): Promise<Value> {
  if (deadline.aborted) throw new WorkOsVerificationUnavailableError();

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(new WorkOsVerificationUnavailableError());
        };
        deadline.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) deadline.removeEventListener("abort", onAbort);
  }
}

export function createWorkOsAccessTokenVerifier(
  options: WorkOsVerifierOptions,
): WorkOsAccessTokenVerifier {
  const issuer = options.issuer ?? WORKOS_DEFAULT_ISSUER;
  const algorithms = [...(options.algorithms ?? DEFAULT_ALGORITHMS)];
  const clockTolerance =
    options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keys =
    options.keys ??
    createRemoteJWKSet(
      options.jwksUrl === undefined
        ? workOsJwksUrl(options.clientId)
        : new URL(options.jwksUrl),
      { timeoutDuration: timeoutMs },
    );

  return {
    async verify(token, { signal }) {
      if (token === "") return null;

      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      let payload: JWTPayload;
      try {
        const verified = await withDeadline(
          jwtVerify(token, keys, {
            issuer,
            algorithms,
            clockTolerance,
            // Both WorkOS token flavors always mint these; a signed token
            // missing exp must not become a permanent credential. aud is
            // enforced through the audience option: session tokens carry
            // none, MCP OAuth tokens bind it to the registered resource.
            requiredClaims: ["sub", "iss", "exp"],
            ...(options.audience === undefined
              ? {}
              : { audience: options.audience }),
          }),
          deadline,
        );
        payload = verified.payload;
      } catch (error) {
        if (isInvalidCredential(error)) return null;
        // No cause and no message detail: a verification failure must not
        // carry token material into a log or an HTTP 500 body.
        throw new WorkOsVerificationUnavailableError();
      }

      return readClaims(payload);
    },
  };
}
