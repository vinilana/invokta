import { randomBytes } from "node:crypto";

import type { Principal } from "@invokta/core";
import type { McpHttpAuthenticationRequest } from "@invokta/mcp";

export interface DevPrincipal {
  readonly token: string;
  readonly principal: Principal;
}

export interface PrincipalStore {
  issue(principal: Principal): DevPrincipal;
  list(): ReadonlyArray<DevPrincipal>;
  revoke(token: string): boolean;
  resolve(token: string): Principal | null;
  authenticate(request: McpHttpAuthenticationRequest): Principal | null;
}

export const defaultPrincipalId = "local-dev";

/**
 * Reads the bearer token of an `Authorization` header value. The scheme is
 * matched case-insensitively per RFC 9110; anything else carries no token.
 */
function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^[ \t]*bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * An in-memory map from minted opaque bearer tokens to development
 * principals. Tokens exist only in process memory; the store performs no
 * persistence and no network activity. The store always starts with one
 * default principal so a fresh dev server is immediately invocable.
 */
export function createPrincipalStore(): PrincipalStore {
  const records = new Map<string, Principal>();

  const issue = (principal: Principal): DevPrincipal => {
    const snapshot = structuredClone(principal);
    const token = randomBytes(24).toString("base64url");
    records.set(token, snapshot);
    return { token, principal: snapshot };
  };

  issue({ id: defaultPrincipalId });

  return {
    issue,
    list: () =>
      [...records.entries()].map(([token, principal]) => ({
        token,
        principal,
      })),
    revoke: (token) => records.delete(token),
    resolve: (token) => records.get(token) ?? null,
    authenticate: (request) => {
      const token = readBearerToken(request.headers.get("authorization"));
      if (token === null) return null;
      return records.get(token) ?? null;
    },
  };
}
