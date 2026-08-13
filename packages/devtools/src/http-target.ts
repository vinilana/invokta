/**
 * Where the MCP HTTP adapter sends an emulated call, and how it authenticates,
 * chartered by ADR 0028. The devtools host is the default and authenticates
 * with its own minted session tokens; an external endpoint is a server the
 * developer runs, whose authentication is whatever that server implements.
 *
 * A credential lives here in process memory for the life of the selection. It
 * is never persisted, never written to the developer's project, and never
 * echoed back: reading the target yields its kind, URL, authentication type,
 * and header or variable names only.
 */

export type HttpAuthenticationType =
  | "session-token"
  | "none"
  | "bearer"
  | "headers"
  | "oauth";

/** A credential value, either literal or named as an environment variable. */
export type CredentialSource =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "environment"; readonly name: string };

export type HttpTargetAuthentication =
  /** The devtools host resolves the selected identity's minted bearer token. */
  | { readonly type: "session-token" }
  | { readonly type: "none" }
  | { readonly type: "bearer"; readonly token: CredentialSource }
  | {
      readonly type: "headers";
      readonly headers: ReadonlyArray<{
        readonly name: string;
        readonly value: CredentialSource;
      }>;
    }
  | { readonly type: "oauth" };

export type HttpTarget =
  | {
      readonly kind: "devtools";
      readonly authentication:
        | { readonly type: "session-token" }
        | { readonly type: "none" };
    }
  | {
      readonly kind: "external";
      readonly url: string;
      readonly authentication: HttpTargetAuthentication;
    };

/** The target as the interface reads it back: no credential value survives. */
export interface HttpTargetView {
  readonly kind: HttpTarget["kind"];
  readonly url?: string;
  readonly authentication: {
    readonly type: HttpAuthenticationType;
    /** Header names only, when the type is `headers`. */
    readonly headerNames?: readonly string[];
    /** Environment variable names the values are read from, when named. */
    readonly environmentVariables?: readonly string[];
    /** Whether an OAuth authorization has completed for this target. */
    readonly authorized?: boolean;
  };
}

/** The authentication shape the MCP client facade accepts, fully resolved. */
export type ResolvedHttpAuthentication =
  | { readonly type: "none" }
  | { readonly type: "bearer"; readonly token: string }
  | {
      readonly type: "headers";
      readonly headers: Readonly<Record<string, string>>;
    };

export type HttpTargetResolution =
  | {
      readonly kind: "devtools";
      /** Whether the selected identity's minted token is presented. */
      readonly useSessionToken: boolean;
    }
  | {
      readonly kind: "external";
      readonly url: string;
      readonly authentication: ResolvedHttpAuthentication;
    }
  | { readonly kind: "external-oauth"; readonly url: string };

export class HttpTargetError extends Error {
  constructor(
    readonly code:
      | "INVALID_TARGET"
      | "INVALID_AUTHENTICATION"
      | "ENVIRONMENT_VALUE_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "HttpTargetError";
  }
}

export interface HttpTargetStore {
  current(): HttpTarget;
  view(): HttpTargetView;
  set(target: HttpTarget): void;
  /** Returns to the devtools host and drops every credential held for it. */
  reset(): void;
  /** Records that an interactive authorization completed for this target. */
  markAuthorized(authorized: boolean): void;
  /**
   * Resolves the target into what one call needs. Throws when a named
   * environment variable is unset, because a silent anonymous call would
   * misreport what the endpoint accepts.
   */
  resolve(): HttpTargetResolution;
  subscribe(listener: () => void): () => void;
}

const defaultTarget: HttpTarget = Object.freeze({
  kind: "devtools",
  authentication: Object.freeze({ type: "session-token" }),
});

const headerName = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const maximumHeaders = 8;

function readEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new HttpTargetError(
      "ENVIRONMENT_VALUE_MISSING",
      `The environment variable ${name} is not set in the dev server's environment.`,
    );
  }
  return value;
}

function readCredential(source: CredentialSource): string {
  return source.kind === "literal"
    ? source.value
    : readEnvironment(source.name);
}

function credentialNames(
  authentication: HttpTargetAuthentication,
): readonly string[] {
  if (authentication.type === "bearer") {
    return authentication.token.kind === "environment"
      ? [authentication.token.name]
      : [];
  }
  if (authentication.type === "headers") {
    return authentication.headers
      .filter((entry) => entry.value.kind === "environment")
      .map((entry) => (entry.value as { readonly name: string }).name);
  }
  return [];
}

function assertCredentialSource(value: unknown): CredentialSource {
  if (typeof value !== "object" || value === null) {
    throw new HttpTargetError(
      "INVALID_AUTHENTICATION",
      "A credential must be a literal value or an environment variable name.",
    );
  }
  const record = value as {
    readonly kind?: unknown;
    readonly value?: unknown;
    readonly name?: unknown;
  };
  if (record.kind === "literal") {
    if (typeof record.value !== "string" || record.value === "") {
      throw new HttpTargetError(
        "INVALID_AUTHENTICATION",
        "The credential value is required.",
      );
    }
    return { kind: "literal", value: record.value };
  }
  if (record.kind === "environment") {
    if (typeof record.name !== "string" || !environmentName.test(record.name)) {
      throw new HttpTargetError(
        "INVALID_AUTHENTICATION",
        "The environment variable name is invalid.",
      );
    }
    return { kind: "environment", name: record.name };
  }
  throw new HttpTargetError(
    "INVALID_AUTHENTICATION",
    "A credential must be a literal value or an environment variable name.",
  );
}

/**
 * Validates a target descriptor received from the interface. The URL itself is
 * left to the MCP client facade, which already refuses anything that is not
 * HTTPS or literal loopback, carries credentials, or has a query or fragment.
 */
export function parseHttpTarget(value: unknown): HttpTarget {
  if (typeof value !== "object" || value === null) {
    throw new HttpTargetError("INVALID_TARGET", "The target is invalid.");
  }
  const record = value as {
    readonly kind?: unknown;
    readonly url?: unknown;
    readonly authentication?: unknown;
  };
  const authentication =
    typeof record.authentication === "object" && record.authentication !== null
      ? (record.authentication as { readonly type?: unknown })
      : undefined;
  const type = authentication?.type;

  if (record.kind === "devtools") {
    if (type !== "session-token" && type !== "none") {
      throw new HttpTargetError(
        "INVALID_AUTHENTICATION",
        "The devtools host accepts its own session token or no credential.",
      );
    }
    return { kind: "devtools", authentication: { type } };
  }
  if (record.kind !== "external") {
    throw new HttpTargetError("INVALID_TARGET", "The target kind is unknown.");
  }
  if (typeof record.url !== "string" || record.url === "") {
    throw new HttpTargetError(
      "INVALID_TARGET",
      "An external endpoint requires an absolute MCP URL.",
    );
  }
  const url = record.url;
  if (type === "none" || type === "oauth") {
    return { kind: "external", url, authentication: { type } };
  }
  if (type === "bearer") {
    const token = assertCredentialSource(
      (authentication as { readonly token?: unknown }).token,
    );
    return { kind: "external", url, authentication: { type, token } };
  }
  if (type === "headers") {
    const raw = (authentication as { readonly headers?: unknown }).headers;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new HttpTargetError(
        "INVALID_AUTHENTICATION",
        "Custom header authentication requires at least one header.",
      );
    }
    if (raw.length > maximumHeaders) {
      throw new HttpTargetError(
        "INVALID_AUTHENTICATION",
        `At most ${String(maximumHeaders)} headers are accepted.`,
      );
    }
    const headers = raw.map((entry) => {
      const candidate = entry as {
        readonly name?: unknown;
        readonly value?: unknown;
      };
      if (
        typeof candidate.name !== "string" ||
        !headerName.test(candidate.name)
      ) {
        throw new HttpTargetError(
          "INVALID_AUTHENTICATION",
          "A header name is invalid.",
        );
      }
      if (candidate.name.toLowerCase() === "host") {
        throw new HttpTargetError(
          "INVALID_AUTHENTICATION",
          "The Host header cannot be overridden.",
        );
      }
      return {
        name: candidate.name,
        value: assertCredentialSource(candidate.value),
      };
    });
    return { kind: "external", url, authentication: { type, headers } };
  }
  throw new HttpTargetError(
    "INVALID_AUTHENTICATION",
    "The authentication type is unknown.",
  );
}

export function createHttpTargetStore(): HttpTargetStore {
  let target: HttpTarget = defaultTarget;
  let authorized = false;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A consumer failure must not affect the stored selection.
      }
    }
  };

  return {
    current: () => target,
    view: () => {
      const names = credentialNames(target.authentication);
      return {
        kind: target.kind,
        ...(target.kind === "external" ? { url: target.url } : {}),
        authentication: {
          type: target.authentication.type,
          ...(target.authentication.type === "headers"
            ? {
                headerNames: target.authentication.headers.map(
                  (entry) => entry.name,
                ),
              }
            : {}),
          ...(names.length === 0 ? {} : { environmentVariables: names }),
          ...(target.authentication.type === "oauth" ? { authorized } : {}),
        },
      };
    },
    set: (next) => {
      target = next;
      authorized = false;
      notify();
    },
    reset: () => {
      target = defaultTarget;
      authorized = false;
      notify();
    },
    markAuthorized: (value) => {
      authorized = value;
      notify();
    },
    resolve: () => {
      if (target.kind === "devtools") {
        return {
          kind: "devtools",
          useSessionToken: target.authentication.type === "session-token",
        };
      }
      if (target.authentication.type === "oauth") {
        return { kind: "external-oauth", url: target.url };
      }
      if (target.authentication.type === "bearer") {
        return {
          kind: "external",
          url: target.url,
          authentication: {
            type: "bearer",
            token: readCredential(target.authentication.token),
          },
        };
      }
      if (target.authentication.type === "headers") {
        const headers: Record<string, string> = {};
        for (const entry of target.authentication.headers) {
          headers[entry.name] = readCredential(entry.value);
        }
        return {
          kind: "external",
          url: target.url,
          authentication: { type: "headers", headers },
        };
      }
      return {
        kind: "external",
        url: target.url,
        authentication: { type: "none" },
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
