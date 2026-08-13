import "../env.js";

import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { reportStartupFailure } from "../env.js";
import { databasePoolConfig, requireDatabaseConfiguration } from "./config.js";

async function main(): Promise<void> {
  requireDatabaseConfiguration();
  const pool = new Pool(databasePoolConfig());
  try {
    for (const name of ["001_oauth.sql"]) {
      const migrationUrl = new URL(`../../migrations/${name}`, import.meta.url);
      const sql = await readFile(migrationUrl, "utf8");
      await pool.query(sql);
    }
    process.stdout.write("Database migration completed.\n");
  } finally {
    await pool.end();
  }
}

main().catch(reportStartupFailure);
