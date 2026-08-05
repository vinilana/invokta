import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

/**
 * Machine-to-machine API keys.
 *
 * A key is `<keyId>.<secret>`. The key id is a public lookup handle; the
 * secret half is the credential. This engine stores only `sha256(secret)`, so a
 * leaked configuration file or database dump never yields a usable key.
 */

const DIGEST_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/u;
const API_KEY_PATTERN = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{16,256})$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

/** A comparand of the right shape for a key id the registry does not know. */
const decoyDigest = Buffer.alloc(DIGEST_BYTES);

export const apiKeyRegistryVariableName = "API_KEY_ENGINE_KEYS";

/** One active key. `secretHash` is the lowercase hex sha256 of the secret. */
export interface ApiKeyRecord {
  readonly keyId: string;
  readonly secretHash: string;
  readonly serviceName: string;
  readonly scopes: ReadonlyArray<string>;
}

/** The verified identity a key proves. It never carries the key itself. */
export interface VerifiedApiKey {
  readonly keyId: string;
  readonly serviceName: string;
  readonly scopes: ReadonlyArray<string>;
}

/**
 * Where active keys live. The shipped implementation reads an environment
 * configured set; a deployment can back it by a database or secret manager
 * instead. A lookup that cannot complete must reject, never return null.
 */
export interface ApiKeyRegistry {
  findByKeyId(
    keyId: string,
    options: { readonly signal: AbortSignal },
  ): Promise<ApiKeyRecord | null>;
}

export interface ApiKeyVerifier {
  verify(
    credential: string,
    options: { readonly signal: AbortSignal },
  ): Promise<VerifiedApiKey | null>;
}

export interface ApiKeyVerifierOptions {
  readonly registry: ApiKeyRegistry;
  /** Bounds the verifier's own lookup, independently of the request signal. */
  readonly lookupTimeoutMs?: number;
}

const recordSchema = z.object({
  keyId: z.string().regex(KEY_ID_PATTERN),
  secretHash: z.string().regex(DIGEST_PATTERN),
  serviceName: z.string().trim().min(1),
  scopes: z.array(z.string().trim().min(1)),
});

/** Hex sha256 of a key's secret half. Used to configure a registry entry. */
export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function parseApiKey(
  credential: string,
): { readonly keyId: string; readonly secret: string } | null {
  const match = API_KEY_PATTERN.exec(credential);
  const keyId = match?.[1];
  const secret = match?.[2];
  if (keyId === undefined || secret === undefined) return null;
  if (!KEY_ID_PATTERN.test(keyId) || !SECRET_PATTERN.test(secret)) return null;
  return { keyId, secret };
}

/**
 * Compares two sha256 digests in constant time. A malformed stored digest is
 * compared against a decoy so a misconfigured entry costs the same as a wrong
 * secret and still denies the request.
 */
function matchesStoredDigest(presented: Buffer, storedHex: string): boolean {
  const stored = DIGEST_PATTERN.test(storedHex)
    ? Buffer.from(storedHex, "hex")
    : null;
  const comparand =
    stored !== null && stored.length === presented.length
      ? stored
      : decoyDigest;
  const equal = timingSafeEqual(presented, comparand);
  return comparand === stored && equal;
}

export function createApiKeyVerifier({
  registry,
  lookupTimeoutMs = 2_000,
}: ApiKeyVerifierOptions): ApiKeyVerifier {
  return {
    async verify(credential, options) {
      const parsed = parseApiKey(credential);
      if (parsed === null) return null;

      const signal = AbortSignal.any([
        options.signal,
        AbortSignal.timeout(lookupTimeoutMs),
      ]);
      // A registry failure propagates: the adapter answers 500 rather than
      // reporting an unverified credential as invalid.
      const record = await registry.findByKeyId(parsed.keyId, { signal });

      // The digest is computed and compared for an unknown key id too, so the
      // response time does not separate "no such key" from "wrong secret".
      const presented = createHash("sha256")
        .update(parsed.secret, "utf8")
        .digest();
      const matches = matchesStoredDigest(
        presented,
        record?.secretHash ?? decoyDigest.toString("hex"),
      );
      if (record === null || !matches) return null;

      return {
        keyId: record.keyId,
        serviceName: record.serviceName,
        scopes: [...record.scopes],
      };
    },
  };
}

export function createInMemoryApiKeyRegistry(
  records: ReadonlyArray<ApiKeyRecord>,
): ApiKeyRegistry {
  const byKeyId = new Map(records.map((record) => [record.keyId, record]));
  return {
    async findByKeyId(keyId) {
      return byKeyId.get(keyId) ?? null;
    },
  };
}

/**
 * Parses the configured key set. Every diagnostic names the variable and the
 * rejected field only: no configured value ever reaches an error message.
 */
export function parseApiKeyRecords(raw: string): ReadonlyArray<ApiKeyRecord> {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error(`${apiKeyRegistryVariableName} must be valid JSON.`);
  }
  if (!Array.isArray(document)) {
    throw new Error(
      `${apiKeyRegistryVariableName} must be a JSON array of key records.`,
    );
  }

  const records = document.map((entry, index) => {
    const parsed = recordSchema.safeParse(entry);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join(".") ?? "record";
      throw new Error(
        `${apiKeyRegistryVariableName}[${index}] has an invalid "${field}" field. Store the hex sha256 of the secret, never the secret.`,
      );
    }
    return parsed.data satisfies ApiKeyRecord;
  });

  const keyIds = new Set(records.map((record) => record.keyId));
  if (keyIds.size !== records.length) {
    throw new Error(
      `${apiKeyRegistryVariableName} must not repeat a key id. Rotate by adding a new key id for the same service.`,
    );
  }
  return records;
}

export function createApiKeyRegistryFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ApiKeyRegistry {
  const raw = environment[apiKeyRegistryVariableName];
  if (raw === undefined || raw === "") {
    throw new Error(`${apiKeyRegistryVariableName} is required.`);
  }
  return createInMemoryApiKeyRegistry(parseApiKeyRecords(raw));
}
