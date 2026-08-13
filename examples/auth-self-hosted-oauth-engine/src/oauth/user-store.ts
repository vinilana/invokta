import type { Pool } from "pg";
import { z } from "zod";

import { hashPassword, verifyPassword } from "./password.js";

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const ownerId = "person:owner";
const maximumFailures = 5;
const lockMinutes = 15;
const dummyHash = hashPassword("not-a-real-user-password");

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly disabled: boolean;
  readonly failed_login_count: number;
  readonly locked_until: Date | null;
}

export interface OAuthAccount {
  readonly id: string;
  readonly email: string;
}

export class OAuthUserStore {
  constructor(private readonly pool: Pool) {}

  async createOwner(
    emailInput: string,
    password: string,
  ): Promise<OAuthAccount> {
    const email = emailSchema.parse(emailInput);
    const passwordHash = await hashPassword(password);
    const result = await this.pool.query<OAuthAccount>(
      `INSERT INTO oauth_users (id, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id, email`,
      [ownerId, email, passwordHash],
    );
    const account = result.rows[0];
    if (account === undefined) {
      throw new Error("The OAuth owner account already exists.");
    }
    return account;
  }

  async findAccount(id: string): Promise<OAuthAccount | null> {
    const result = await this.pool.query<OAuthAccount & { disabled: boolean }>(
      "SELECT id, email, disabled FROM oauth_users WHERE id = $1",
      [id],
    );
    const account = result.rows[0];
    if (account === undefined || account.disabled) return null;
    return { id: account.id, email: account.email };
  }

  async authenticate(
    emailInput: string,
    password: string,
  ): Promise<OAuthAccount | null> {
    const email = emailInput.trim().toLowerCase();
    const result = await this.pool.query<UserRow>(
      `SELECT id, email, password_hash, disabled,
              failed_login_count, locked_until
       FROM oauth_users
       WHERE email = $1`,
      [email],
    );
    const user = result.rows[0];
    if (user === undefined) {
      await verifyPassword(password, await dummyHash);
      return null;
    }
    const valid = await verifyPassword(password, user.password_hash);
    const locked =
      user.locked_until !== null && user.locked_until.getTime() > Date.now();
    if (!valid || user.disabled || locked) {
      if (!user.disabled && !locked) {
        await this.pool.query(
          `UPDATE oauth_users
           SET failed_login_count = failed_login_count + 1,
               locked_until = CASE
                 WHEN failed_login_count + 1 >= $2
                   THEN now() + ($3 * interval '1 minute')
                 ELSE locked_until
               END,
               updated_at = now()
           WHERE id = $1`,
          [user.id, maximumFailures, lockMinutes],
        );
      }
      return null;
    }
    await this.pool.query(
      `UPDATE oauth_users
       SET failed_login_count = 0, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [user.id],
    );
    return { id: user.id, email: user.email };
  }
}
