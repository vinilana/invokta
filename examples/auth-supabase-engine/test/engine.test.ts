import { beforeAll, describe, expect, it } from "vitest";

import { engine } from "../src/engine.js";
import { toSupabasePrincipal } from "../src/identity/principal.js";
import { createSupabaseVerifier } from "../src/identity/verifier.js";
import {
  createTokenFactory,
  issuer,
  sessionId,
  type SupabaseTokenFactory,
  subject,
} from "./tokens.js";

let tokens: SupabaseTokenFactory;

beforeAll(async () => {
  tokens = await createTokenFactory();
});

describe("identity.whoami", () => {
  it("reports the verified Supabase identity", async () => {
    const verifier = createSupabaseVerifier({ issuer, keys: tokens.keys });
    const identity = await verifier.verify(await tokens.sign(), {
      signal: new AbortController().signal,
    });
    if (identity === null) throw new Error("Expected a verified identity.");

    await expect(
      engine.invoke(
        "identity.whoami",
        {},
        { source: "direct", principal: toSupabasePrincipal(identity) },
      ),
    ).resolves.toEqual({
      principalId: subject,
      attributes: {
        role: "authenticated",
        email: "ada@example.com",
        sessionId,
      },
    });
  });

  it("ignores identity fields supplied as capability input", async () => {
    const spoofedInput = {
      principalId: "attacker",
      role: "service_role",
    } as unknown as Record<string, never>;

    await expect(
      engine.invoke("identity.whoami", spoofedInput, {
        source: "direct",
        principal: { id: subject, attributes: { role: "authenticated" } },
      }),
    ).resolves.toEqual({
      principalId: subject,
      attributes: { role: "authenticated" },
    });
  });

  it("refuses an unauthenticated invocation", async () => {
    await expect(
      engine.invoke(
        "identity.whoami",
        {},
        { source: "direct", principal: null },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
