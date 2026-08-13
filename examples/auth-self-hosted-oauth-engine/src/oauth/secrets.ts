import { randomBytes, randomUUID } from "node:crypto";

import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { Pool, PoolClient } from "pg";

const cookieKeysSetting = "cookie_keys";
const signingKeysSetting = "signing_jwks";
const advisoryLockId = 7_412_026;

export interface OAuthSecrets {
  readonly cookieKeys: readonly string[];
  readonly jwks: { readonly keys: readonly JWK[] };
}

interface SettingRow {
  readonly key: string;
  readonly value: unknown;
}

async function createSigningJwks(): Promise<{ readonly keys: readonly JWK[] }> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const key = await exportJWK(privateKey);
  return {
    keys: [{ ...key, alg: "ES256", kid: randomUUID(), use: "sig" }],
  };
}

function parseSecrets(rows: readonly SettingRow[]): OAuthSecrets {
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const cookieKeys = values.get(cookieKeysSetting);
  const jwks = values.get(signingKeysSetting);
  if (
    !Array.isArray(cookieKeys) ||
    cookieKeys.length < 2 ||
    cookieKeys.some((value) => typeof value !== "string" || value.length < 32)
  ) {
    throw new Error("The OAuth cookie key store is invalid.");
  }
  if (
    typeof jwks !== "object" ||
    jwks === null ||
    !("keys" in jwks) ||
    !Array.isArray(jwks.keys) ||
    jwks.keys.length === 0
  ) {
    throw new Error("The OAuth signing key store is invalid.");
  }
  return {
    cookieKeys: cookieKeys as string[],
    jwks: jwks as { keys: JWK[] },
  };
}

async function initialize(client: PoolClient): Promise<OAuthSecrets> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [advisoryLockId]);
    const candidateCookieKeys = [
      randomBytes(32).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ];
    const candidateJwks = await createSigningJwks();
    await client.query(
      `INSERT INTO oauth_settings (key, value)
       VALUES ($1, $2::jsonb), ($3, $4::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [
        cookieKeysSetting,
        JSON.stringify(candidateCookieKeys),
        signingKeysSetting,
        JSON.stringify(candidateJwks),
      ],
    );
    const result = await client.query<SettingRow>(
      "SELECT key, value FROM oauth_settings WHERE key = ANY($1::text[])",
      [[cookieKeysSetting, signingKeysSetting]],
    );
    const secrets = parseSecrets(result.rows);
    await client.query("COMMIT");
    return secrets;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function loadOrCreateOAuthSecrets(
  pool: Pool,
): Promise<OAuthSecrets> {
  const client = await pool.connect();
  try {
    return await initialize(client);
  } finally {
    client.release();
  }
}
