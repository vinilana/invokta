interface OAuthRequestIdentity {
  readonly method?: unknown;
  readonly path?: unknown;
}

interface OAuthRequestCompletion extends OAuthRequestIdentity {
  readonly issuer: string;
  readonly location?: unknown;
  readonly status: number;
}

function diagnosticToken(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_./-]{1,100}$/.test(value)) {
    return fallback;
  }
  return value;
}

export function oauthDiagnosticRoute(path: unknown): string | null {
  if (typeof path !== "string") return null;
  if (/^\/auth(?:\/|$)/.test(path)) return "authorization";
  if (/^\/interaction\/[^/]+\/consent$/.test(path)) {
    return "interaction_consent";
  }
  if (/^\/interaction\/[^/]+\/login$/.test(path)) return "interaction_login";
  if (/^\/interaction\/[^/]+$/.test(path)) return "interaction";
  if (path === "/token") return "token";
  if (path === "/reg") return "registration";
  return null;
}

function redirectDiagnostic(issuer: string, location: unknown): string {
  if (typeof location !== "string" || location === "") return "none";
  try {
    const target = new URL(location, issuer);
    return target.origin === new URL(issuer).origin ? "self" : target.origin;
  } catch {
    return "invalid";
  }
}

export function formatOAuthRequestCompletion(
  request: OAuthRequestCompletion,
): string {
  const method = diagnosticToken(request.method, "UNKNOWN");
  const route = oauthDiagnosticRoute(request.path) ?? "unknown";
  const status = Number.isSafeInteger(request.status) ? request.status : 500;
  const redirect = redirectDiagnostic(request.issuer, request.location);
  return `OAuth request completed: method=${method} route=${route} status=${status} redirect=${redirect}.\n`;
}

export function formatOAuthRequestFailure(
  request: OAuthRequestIdentity,
  failure: unknown,
): string {
  const details =
    typeof failure === "object" && failure !== null
      ? (failure as Record<string, unknown>)
      : {};
  const method = diagnosticToken(request.method, "UNKNOWN");
  const route = oauthDiagnosticRoute(request.path) ?? "unknown";
  const code = diagnosticToken(
    details.error ?? details.code ?? details.name,
    "unknown_error",
  );
  const status =
    typeof details.statusCode === "number" &&
    Number.isSafeInteger(details.statusCode) &&
    details.statusCode >= 400 &&
    details.statusCode <= 599
      ? details.statusCode
      : 500;
  return `OAuth request failed: method=${method} route=${route} status=${status} code=${code}.\n`;
}
