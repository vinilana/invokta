import { describe, expect, it, vi } from "vitest";

/**
 * Structural guard for the constant-time comparison. The behavioral suite
 * cannot tell `timingSafeEqual` apart from `===` over digests, so this file
 * pins the mechanism itself: every verification outcome — match, wrong
 * secret, unknown key id — must route through `node:crypto.timingSafeEqual`.
 */

const timingSafeEqualSpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: Uint8Array, b: Uint8Array): boolean => {
      timingSafeEqualSpy.calls += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { createApiKeyVerifier, createInMemoryApiKeyRegistry, hashApiKeySecret } =
  await import("../src/identity/verifier.js");

const secret = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const registry = createInMemoryApiKeyRegistry([
  {
    keyId: "svc_reports_2026a",
    secretHash: hashApiKeySecret(secret),
    serviceName: "reports-worker",
    scopes: ["identity:read"],
  },
]);

function verify(credential: string) {
  return createApiKeyVerifier({ registry }).verify(credential, {
    signal: new AbortController().signal,
  });
}

describe("constant-time digest comparison", () => {
  it("routes a matching secret through timingSafeEqual", async () => {
    timingSafeEqualSpy.calls = 0;

    await expect(verify(`svc_reports_2026a.${secret}`)).resolves.toMatchObject({
      serviceName: "reports-worker",
    });
    expect(timingSafeEqualSpy.calls).toBe(1);
  });

  it("routes a wrong secret through timingSafeEqual before denying", async () => {
    timingSafeEqualSpy.calls = 0;

    await expect(
      verify("svc_reports_2026a.ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA"),
    ).resolves.toBeNull();
    expect(timingSafeEqualSpy.calls).toBe(1);
  });

  it("routes an unknown key id through the decoy comparison", async () => {
    timingSafeEqualSpy.calls = 0;

    await expect(verify(`svc_absent_0000a.${secret}`)).resolves.toBeNull();
    expect(timingSafeEqualSpy.calls).toBe(1);
  });
});
