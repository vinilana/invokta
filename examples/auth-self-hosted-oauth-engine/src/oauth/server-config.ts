import { EngineStartupError, type EnvironmentRecord } from "../env.js";

export interface OAuthServerConfiguration {
  readonly issuer: string;
  readonly resource: string;
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
}

function publicUrl(environment: EnvironmentRecord): URL {
  const value = environment.APP_PUBLIC_URL;
  if (value === undefined || value === "") {
    throw new EngineStartupError("APP_PUBLIC_URL is required.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EngineStartupError("APP_PUBLIC_URL must be an absolute URL.");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new EngineStartupError(
      "APP_PUBLIC_URL must use HTTPS except for loopback development.",
    );
  }
  if (
    url.pathname !== "/" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new EngineStartupError(
      "APP_PUBLIC_URL must be an origin without credentials, path, query, or fragment.",
    );
  }
  return url;
}

function port(environment: EnvironmentRecord): number {
  const value = environment.INVOKTA_OAUTH_PORT ?? "3001";
  const parsed = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new EngineStartupError(
      "INVOKTA_OAUTH_PORT must be an integer between 1 and 65535.",
    );
  }
  return parsed;
}

function allowedHosts(
  environment: EnvironmentRecord,
  hostname: string,
): readonly string[] {
  const configured = environment.INVOKTA_OAUTH_ALLOWED_HOSTS;
  if (configured === undefined) {
    return [...new Set([hostname, "auth", "localhost", "127.0.0.1"])];
  }
  const values = configured
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "");
  if (values.length === 0) {
    throw new EngineStartupError(
      "INVOKTA_OAUTH_ALLOWED_HOSTS must list at least one host.",
    );
  }
  return [...new Set(values)];
}

export function readOAuthServerConfiguration(
  environment: EnvironmentRecord = process.env,
): OAuthServerConfiguration {
  const url = publicUrl(environment);
  return {
    issuer: url.origin,
    resource: `${url.origin}/mcp`,
    host: environment.INVOKTA_OAUTH_HOST ?? "127.0.0.1",
    port: port(environment),
    allowedHosts: allowedHosts(environment, url.hostname.toLowerCase()),
  };
}
