import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { toPrincipal } from "../src/identity/principal.js";
import {
  type ApiKeyRecord,
  type ApiKeyRegistry,
  createApiKeyVerifier,
  createInMemoryApiKeyRegistry,
  hashApiKeySecret,
  parseApiKey,
  parseApiKeyRecords,
} from "../src/identity/verifier.js";

const secret = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const rotatedSecret = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA";
const records: ReadonlyArray<ApiKeyRecord> = [
  {
    keyId: "svc_reports_2026a",
    secretHash: hashApiKeySecret(secret),
    serviceName: "reports-worker",
    scopes: ["identity:read"],
  },
  {
    keyId: "svc_reports_2026b",
    secretHash: hashApiKeySecret(rotatedSecret),
    serviceName: "reports-worker",
    scopes: ["identity:read"],
  },
];

function createVerifier(
  registry: ApiKeyRegistry = createInMemoryApiKeyRegistry(records),
) {
  return createApiKeyVerifier({ registry });
}

function verify(credential: string, registry?: ApiKeyRegistry) {
  return createVerifier(registry).verify(credential, {
    signal: new AbortController().signal,
  });
}

describe("api key verifier", () => {
  it("accepts a valid key and returns only authorization-relevant data", async () => {
    await expect(verify(`svc_reports_2026a.${secret}`)).resolves.toEqual({
      keyId: "svc_reports_2026a",
      serviceName: "reports-worker",
      scopes: ["identity:read"],
    });
  });

  it("accepts every active key of one service so rotation never needs downtime", async () => {
    await expect(verify(`svc_reports_2026b.${secret}`)).resolves.toBeNull();
    await expect(
      verify(`svc_reports_2026b.${rotatedSecret}`),
    ).resolves.toMatchObject({ serviceName: "reports-worker" });
  });

  it.each([
    ["an empty credential", ""],
    ["a credential without the key-id separator", secret],
    ["a credential with an empty key id", `.${secret}`],
    ["a credential with an empty secret", "svc_reports_2026a."],
    ["a credential with a whitespace secret", "svc_reports_2026a.   "],
    ["a credential with an extra segment", `svc_reports_2026a.${secret}.extra`],
    ["an unknown key id", `svc_unknown.${secret}`],
    [
      "a known key id with the wrong secret",
      `svc_reports_2026a.${rotatedSecret}`,
    ],
  ])("rejects %s with null", async (_label, credential) => {
    await expect(verify(credential)).resolves.toBeNull();
  });

  it("compares digests, never the presented secret against a stored plaintext", async () => {
    const plaintextRegistry = createInMemoryApiKeyRegistry([
      {
        keyId: "svc_misconfigured",
        secretHash: secret,
        serviceName: "reports-worker",
        scopes: [],
      },
    ]);

    await expect(
      verify(`svc_misconfigured.${secret}`, plaintextRegistry),
    ).resolves.toBeNull();
    expect(hashApiKeySecret(secret)).toBe(
      createHash("sha256").update(secret, "utf8").digest("hex"),
    );
  });

  it("hashes the presented secret before the lookup result decides the outcome", async () => {
    const findByKeyId = vi.fn<ApiKeyRegistry["findByKeyId"]>(async () => null);

    await expect(
      verify(`svc_reports_2026a.${secret}`, { findByKeyId }),
    ).resolves.toBeNull();
    expect(findByKeyId).toHaveBeenCalledOnce();
    expect(findByKeyId.mock.calls[0]?.[0]).toBe("svc_reports_2026a");
    expect(findByKeyId.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("throws when the registry cannot complete the lookup", async () => {
    const registry: ApiKeyRegistry = {
      async findByKeyId() {
        throw new Error("registry unavailable");
      },
    };

    await expect(
      verify(`svc_reports_2026a.${secret}`, registry),
    ).rejects.toThrow(/registry unavailable/u);
  });

  it("propagates caller cancellation to the registry lookup", async () => {
    const controller = new AbortController();
    const registry: ApiKeyRegistry = {
      async findByKeyId(_keyId, options) {
        options.signal.throwIfAborted();
        return null;
      },
    };
    controller.abort();

    await expect(
      createApiKeyVerifier({ registry }).verify(`svc_reports_2026a.${secret}`, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the credential out of the produced principal", async () => {
    const verified = await verify(`svc_reports_2026a.${secret}`);
    if (verified === null) throw new Error("Expected a verified key.");
    const principal = toPrincipal(verified);

    expect(principal).toEqual({
      id: "reports-worker",
      attributes: { keyId: "svc_reports_2026a", scopes: ["identity:read"] },
    });
    const serialized = JSON.stringify(principal);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(records[0]?.secretHash);
    expect(structuredClone(principal)).toEqual(principal);
  });
});

describe("api key parsing", () => {
  it("splits a well-formed key into its key id and secret", () => {
    expect(parseApiKey(`svc_reports_2026a.${secret}`)).toEqual({
      keyId: "svc_reports_2026a",
      secret,
    });
  });

  it("rejects a key id or secret outside the accepted alphabet", () => {
    expect(parseApiKey(`svc reports.${secret}`)).toBeNull();
    expect(parseApiKey("svc_reports_2026a.short")).toBeNull();
  });
});

describe("api key registry configuration", () => {
  it("parses a configured key set", () => {
    const parsed = parseApiKeyRecords(
      JSON.stringify([
        {
          keyId: "svc_reports_2026a",
          secretHash: hashApiKeySecret(secret),
          serviceName: "reports-worker",
          scopes: ["identity:read"],
        },
      ]),
    );

    expect(parsed).toEqual([
      {
        keyId: "svc_reports_2026a",
        secretHash: hashApiKeySecret(secret),
        serviceName: "reports-worker",
        scopes: ["identity:read"],
      },
    ]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-array document", "{}"],
    [
      "a plaintext secret in place of a digest",
      JSON.stringify([
        { keyId: "a", secretHash: secret, serviceName: "s", scopes: [] },
      ]),
    ],
    [
      "an entry carrying an unrecognized field",
      JSON.stringify([
        {
          keyId: "svc_reports_2026a",
          secretHash: hashApiKeySecret(secret),
          serviceName: "reports-worker",
          scopes: ["identity:read"],
          secret,
        },
      ]),
    ],
    [
      "a duplicate key id",
      JSON.stringify([
        {
          keyId: "a",
          secretHash: hashApiKeySecret(secret),
          serviceName: "s",
          scopes: [],
        },
        {
          keyId: "a",
          secretHash: hashApiKeySecret(rotatedSecret),
          serviceName: "s",
          scopes: [],
        },
      ]),
    ],
  ])("rejects %s without echoing the configuration", (_label, raw) => {
    try {
      parseApiKeyRecords(raw);
      throw new Error("Expected the configuration to be rejected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).toMatch(/API_KEY_ENGINE_KEYS/u);
    }
  });

  it("never keeps a plaintext secret in the registry", () => {
    const generated = randomBytes(32).toString("base64url");
    const parsed = parseApiKeyRecords(
      JSON.stringify([
        {
          keyId: "svc_generated",
          secretHash: hashApiKeySecret(generated),
          serviceName: "reports-worker",
          scopes: [],
        },
      ]),
    );

    expect(JSON.stringify(parsed)).not.toContain(generated);
  });
});
