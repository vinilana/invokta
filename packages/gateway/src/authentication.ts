import type { Principal } from "@invokta/core";

/**
 * The request an HTTP adapter passes to its `authenticate` hook. It is
 * structurally identical to `HttpAuthenticationRequest` from `@invokta/http`
 * and `McpHttpAuthenticationRequest` from `@invokta/mcp`.
 */
export interface GatewayAuthenticationRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: {
    readonly get: (name: string) => string | null;
    readonly has: (name: string) => boolean;
  };
  readonly signal: AbortSignal;
}

/**
 * An `authenticate` hook: a principal for valid credentials, `null` for
 * missing or invalid credentials, and a thrown error for an infrastructure
 * failure. `createJwtBearerAuthenticator` from `@invokta/auth-jwt` is one.
 */
export type GatewayAuthenticator = (
  request: GatewayAuthenticationRequest,
) => Principal | null | Promise<Principal | null>;

/**
 * Tries several authentication methods in order and returns the first
 * principal. A method that throws stops the chain, so the adapter answers
 * with its sanitized infrastructure failure instead of trying weaker methods.
 */
export function chainAuthenticators(
  ...authenticators: ReadonlyArray<GatewayAuthenticator>
): GatewayAuthenticator {
  if (authenticators.length === 0) {
    throw new TypeError(
      "chainAuthenticators needs at least one authenticator.",
    );
  }
  for (const authenticator of authenticators) {
    if (typeof authenticator !== "function") {
      throw new TypeError("Every authenticator must be a function.");
    }
  }
  const chain = Object.freeze([...authenticators]);
  return async (request) => {
    for (const authenticate of chain) {
      const principal = await authenticate(request);
      if (principal !== null) return principal;
    }
    return null;
  };
}

/** One accepted API key, stored as the SHA-256 digest of the key. */
export interface ApiKeyCredential {
  /** The principal ID of the key's holder. */
  readonly id: string;
  /** Lowercase hex SHA-256 of the key, for example from `hashApiKey`. */
  readonly sha256: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface ApiKeyAuthenticatorOptions {
  /** The request header carrying the key. Defaults to `x-api-key`. */
  readonly header?: string;
  readonly keys: ReadonlyArray<ApiKeyCredential>;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAXIMUM_KEY_LENGTH = 1_024;

/** Returns the lowercase hex SHA-256 digest of an API key. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Authenticates static API keys sent in one header. The configuration holds
 * only digests; every presented key is hashed and compared against every
 * configured digest without an early exit.
 */
export function apiKeyAuthenticator(
  options: ApiKeyAuthenticatorOptions,
): GatewayAuthenticator {
  const header = options.header ?? "x-api-key";
  if (typeof header !== "string" || !HEADER_NAME.test(header)) {
    throw new TypeError("apiKeyAuthenticator header must be a header name.");
  }
  if (!Array.isArray(options.keys) || options.keys.length === 0) {
    throw new TypeError("apiKeyAuthenticator needs at least one key.");
  }
  const ids = new Set<string>();
  const keys = options.keys.map((key) => {
    if (typeof key.id !== "string" || key.id === "" || ids.has(key.id)) {
      throw new TypeError("Every API key needs a unique, non-empty id.");
    }
    if (typeof key.sha256 !== "string" || !DIGEST.test(key.sha256)) {
      throw new TypeError(`API key ${key.id} sha256 must be a hex digest.`);
    }
    ids.add(key.id);
    const principal: Principal = Object.freeze({
      id: key.id,
      ...(key.attributes === undefined
        ? {}
        : { attributes: Object.freeze(structuredClone(key.attributes)) }),
    });
    return Object.freeze({ digest: key.sha256, principal });
  });

  return async ({ headers }) => {
    const presented = headers.get(header);
    if (
      presented === null ||
      presented === "" ||
      presented.length > MAXIMUM_KEY_LENGTH
    ) {
      return null;
    }
    const digest = await hashApiKey(presented);
    let match: Principal | null = null;
    for (const key of keys) {
      if (constantTimeEqual(digest, key.digest)) match = key.principal;
    }
    return match === null ? null : structuredClone(match);
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |=
      left.charCodeAt(index) ^ right.charCodeAt(index % right.length);
  }
  return difference === 0;
}
