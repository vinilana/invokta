import { randomBytes } from "node:crypto";

import type { Principal } from "@invokta/core";
import type { McpHttpAuthenticationRequest } from "@invokta/mcp";

export interface DevPrincipal {
  /** Stable management key; safe to list and reference from the interface. */
  readonly key: string;
  /** Opaque bearer credential; returned only when it is minted. */
  readonly token: string;
  readonly principal: Principal;
}

export interface PrincipalStore {
  issue(principal: Principal): DevPrincipal;
  /** Mints a replacement token for an existing principal, revoking the old one. */
  rotate(key: string): DevPrincipal | null;
  remove(key: string): boolean;
  list(): ReadonlyArray<DevPrincipal>;
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
  const records = new Map<string, { token: string; principal: Principal }>();
  let nextKey = 0;

  const mintToken = (): string => randomBytes(24).toString("base64url");

  const issue = (principal: Principal): DevPrincipal => {
    const snapshot = structuredClone(principal);
    nextKey += 1;
    const key = `p${String(nextKey)}`;
    const token = mintToken();
    records.set(key, { token, principal: snapshot });
    return { key, token, principal: snapshot };
  };

  issue({ id: defaultPrincipalId });

  return {
    issue,
    rotate: (key) => {
      const record = records.get(key);
      if (record === undefined) return null;
      record.token = mintToken();
      return { key, token: record.token, principal: record.principal };
    },
    remove: (key) => records.delete(key),
    list: () =>
      [...records.entries()].map(([key, record]) => ({
        key,
        token: record.token,
        principal: record.principal,
      })),
    resolve: (token) => {
      for (const record of records.values()) {
        if (record.token === token) return record.principal;
      }
      return null;
    },
    authenticate: (request) => {
      const token = readBearerToken(request.headers.get("authorization"));
      if (token === null) return null;
      for (const record of records.values()) {
        if (record.token === token) return record.principal;
      }
      return null;
    },
  };
}
