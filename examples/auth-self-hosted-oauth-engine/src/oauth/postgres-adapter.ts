import type { Adapter, AdapterPayload } from "oidc-provider";
import type { Pool } from "pg";

interface ArtifactRow {
  readonly payload: AdapterPayload;
  readonly consumed_at: Date | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export class PostgresOidcAdapter implements Adapter {
  constructor(
    private readonly pool: Pool,
    private readonly model: string,
  ) {}

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn?: number,
  ): Promise<void> {
    const expiresAt =
      expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1_000);
    await this.pool.query(
      `INSERT INTO oauth_artifacts
         (model, id, payload, grant_id, user_code, uid, expires_at, consumed_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, NULL)
       ON CONFLICT (model, id) DO UPDATE SET
         payload = EXCLUDED.payload,
         grant_id = EXCLUDED.grant_id,
         user_code = EXCLUDED.user_code,
         uid = EXCLUDED.uid,
         expires_at = EXCLUDED.expires_at,
         consumed_at = NULL`,
      [
        this.model,
        id,
        JSON.stringify(payload),
        optionalString(payload.grantId),
        optionalString(payload.userCode),
        optionalString(payload.uid),
        expiresAt,
      ],
    );
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.findBy("id", id);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findBy("user_code", userCode);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findBy("uid", uid);
  }

  async consume(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE oauth_artifacts
       SET consumed_at = now()
       WHERE model = $1 AND id = $2`,
      [this.model, id],
    );
  }

  async destroy(id: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM oauth_artifacts WHERE model = $1 AND id = $2",
      [this.model, id],
    );
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM oauth_artifacts WHERE model = $1 AND grant_id = $2",
      [this.model, grantId],
    );
  }

  private async findBy(
    column: "id" | "user_code" | "uid",
    value: string,
  ): Promise<AdapterPayload | undefined> {
    const result = await this.pool.query<ArtifactRow>(
      `SELECT payload, consumed_at
       FROM oauth_artifacts
       WHERE model = $1
         AND ${column} = $2
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [this.model, value],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return row.consumed_at === null
      ? row.payload
      : { ...row.payload, consumed: row.consumed_at.getTime() };
  }
}

export function createPostgresOidcAdapter(pool: Pool) {
  return (name: string): Adapter => new PostgresOidcAdapter(pool, name);
}
