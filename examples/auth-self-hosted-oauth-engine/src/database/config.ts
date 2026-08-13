import type { PoolConfig } from "pg";

import {
  EngineStartupError,
  requireEnvironment,
  type EnvironmentRecord,
} from "../env.js";

const postgresVariableNames = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
] as const;

export function requireDatabaseConfiguration(
  environment: EnvironmentRecord = process.env,
): void {
  if (
    environment.DATABASE_URL !== undefined &&
    environment.DATABASE_URL !== ""
  ) {
    return;
  }
  requireEnvironment(postgresVariableNames, { env: environment });
}

export function databasePoolConfig(
  environment: EnvironmentRecord = process.env,
): PoolConfig {
  const connectionString = environment.DATABASE_URL;
  if (connectionString !== undefined && connectionString !== "") {
    return { connectionString };
  }

  const portText = environment.PGPORT;
  const port = portText === undefined ? undefined : Number(portText);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new EngineStartupError(
      "PGPORT must be an integer between 1 and 65535.",
    );
  }

  return {
    ...(environment.PGHOST === undefined ? {} : { host: environment.PGHOST }),
    ...(port === undefined ? {} : { port }),
    ...(environment.PGDATABASE === undefined
      ? {}
      : { database: environment.PGDATABASE }),
    ...(environment.PGUSER === undefined ? {} : { user: environment.PGUSER }),
    ...(environment.PGPASSWORD === undefined
      ? {}
      : { password: environment.PGPASSWORD }),
  };
}
