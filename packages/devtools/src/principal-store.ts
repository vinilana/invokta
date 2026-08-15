import { randomBytes } from "node:crypto";

import type { Principal } from "@invokta/core";
import type { McpHttpAuthenticationRequest } from "@invokta/mcp";

export interface DevPrincipal {
  /** Stable management key; safe to list and reference from the interface. */
  readonly key: string;
  /**
   * Opaque bearer credential. `issue` and `rotate` return it only when it is
   * minted; `list` also carries it so the in-process watch-mode mirror can
   * forward the token table to the engine-host child. The HTTP interface
   * strips it from list responses.
   */
  readonly token: string;
  readonly principal: Principal;
}

export interface PrincipalStore {
  issue(principal: Principal): DevPrincipal;
  /** Replaces an existing principal, keeping its key and its token. */
  update(key: string, principal: Principal): DevPrincipal | null;
  /** Mints a replacement token for an existing principal, revoking the old one. */
  rotate(key: string): DevPrincipal | null;
  remove(key: string): boolean;
  list(): ReadonlyArray<DevPrincipal>;
  resolve(token: string): Principal | null;
  authenticate(request: McpHttpAuthenticationRequest): Principal | null;
  /** Notifies after every mutation; used to mirror tokens into a child host. */
  subscribe(listener: () => void): () => void;
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
  const listeners = new Set<() => void>();

  const mintToken = (): string => randomBytes(24).toString("base64url");
  const mintKey = (): string => {
    let key: string;
    do {
      key = `p_${randomBytes(9).toString("base64url")}`;
    } while (records.has(key));
    return key;
  };

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A mirror consumer failure must not affect the store.
      }
    }
  };

  const issue = (principal: Principal): DevPrincipal => {
    const snapshot = structuredClone(principal);
    const key = mintKey();
    const token = mintToken();
    records.set(key, { token, principal: snapshot });
    notify();
    return { key, token, principal: snapshot };
  };

  issue({ id: defaultPrincipalId });

  return {
    issue,
    update: (key, principal) => {
      const record = records.get(key);
      if (record === undefined) return null;
      record.principal = structuredClone(principal);
      notify();
      return { key, token: record.token, principal: record.principal };
    },
    rotate: (key) => {
      const record = records.get(key);
      if (record === undefined) return null;
      record.token = mintToken();
      notify();
      return { key, token: record.token, principal: record.principal };
    },
    remove: (key) => {
      const removed = records.delete(key);
      if (removed) notify();
      return removed;
    },
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
