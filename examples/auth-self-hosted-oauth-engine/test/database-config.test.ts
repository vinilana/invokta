import { describe, expect, it } from "vitest";

import {
  databasePoolConfig,
  requireDatabaseConfiguration,
} from "../src/database/config.js";

describe("database configuration", () => {
  it("prefers DATABASE_URL when it is configured", () => {
    const env = {
      DATABASE_URL: "postgresql://user:password@database:5432/invokta_app",
      PGHOST: "ignored",
    };

    expect(databasePoolConfig(env)).toEqual({
      connectionString: env.DATABASE_URL,
    });
    expect(() => requireDatabaseConfiguration(env)).not.toThrow();
  });

  it("supports discrete PostgreSQL variables for container deployment", () => {
    const env = {
      PGHOST: "postgres",
      PGPORT: "5432",
      PGDATABASE: "invokta_app",
      PGUSER: "invokta_app",
      PGPASSWORD: "password-with-special-characters:@/",
    };

    expect(databasePoolConfig(env)).toEqual({
      host: "postgres",
      port: 5432,
      database: "invokta_app",
      user: "invokta_app",
      password: "password-with-special-characters:@/",
    });
    expect(() => requireDatabaseConfiguration(env)).not.toThrow();
  });

  it("rejects incomplete or invalid discrete configuration", () => {
    expect(() => requireDatabaseConfiguration({ PGHOST: "postgres" })).toThrow(
      "A required environment variable is missing",
    );
    expect(() =>
      databasePoolConfig({
        PGHOST: "postgres",
        PGPORT: "invalid",
      }),
    ).toThrow("PGPORT must be an integer");
  });
});
