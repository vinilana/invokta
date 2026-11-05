/**
 * Executable copies of every code block in the "Wrap capabilities with
 * middleware" recipe (apps/docs/src/content/docs/recipes/capability-middleware.mdx).
 *
 * These are documentation examples, not framework exports. The docs site
 * contract (apps/docs/test/site-contract.node.mjs) requires each block between
 * recipe markers, with its commented `// import` lines restored, to equal one
 * code block on the recipe page, and every page block to have such a copy.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AnyCapability,
  applyMiddleware,
  type CapabilityMiddleware,
  composeCapabilities,
  createEngine,
  defineCapability,
  defineExportedCapability,
  EngineError,
  type EngineLogger,
  importCapability,
  isComposedCapabilities,
} from "../src/index.js";

// --- recipe: timing ------------------------------------------------------
// import type { CapabilityMiddleware } from "@invokta/core";

const timing: CapabilityMiddleware = async ({
  capabilityId,
  context,
  next,
}) => {
  const startedAt = performance.now();
  try {
    return await next();
  } finally {
    context.logger.debug("capability.timing", {
      capabilityId,
      durationMs: performance.now() - startedAt,
    });
  }
};
// --- end recipe ----------------------------------------------------------

// --- recipe: audit log ---------------------------------------------------
// import { type CapabilityMiddleware, EngineError } from "@invokta/core";

export const auditLog: CapabilityMiddleware = async ({
  capabilityId,
  context,
  next,
}) => {
  const startedAt = performance.now();
  let outcome: "returned" | "threw" = "threw";
  let code: string | undefined;
  try {
    const output = await next();
    outcome = "returned";
    return output;
  } catch (error) {
    if (error instanceof EngineError) code = error.code;
    throw error;
  } finally {
    context.logger.info("capability.audit", {
      capabilityId,
      requestId: context.requestId,
      source: context.source,
      principalId: context.principal?.id ?? null,
      outcome,
      ...(code === undefined ? {} : { code }),
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
};
// --- end recipe ----------------------------------------------------------

// --- recipe: rate limit --------------------------------------------------
// import { type CapabilityMiddleware, EngineError } from "@invokta/core";

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

export interface RateLimitOptions {
  /** Invocations allowed per principal and capability in one window. */
  readonly limit: number;
  readonly windowMs: number;
  /** Upper bound on tracked principal and capability pairs. */
  readonly maxTrackedKeys: number;
  readonly now?: () => number;
}

export function createRateLimit(
  options: RateLimitOptions,
): CapabilityMiddleware {
  const { limit, windowMs, maxTrackedKeys, now = Date.now } = options;
  assertPositiveInteger("limit", limit);
  assertPositiveInteger("windowMs", windowMs);
  assertPositiveInteger("maxTrackedKeys", maxTrackedKeys);
  const windows = new Map<string, { startedAt: number; count: number }>();

  return async ({ capabilityId, context, next }) => {
    const key = JSON.stringify([capabilityId, context.principal?.id ?? null]);
    const at = now();
    let window = windows.get(key);
    if (window === undefined || at - window.startedAt >= windowMs) {
      windows.delete(key);
      window = { startedAt: at, count: 0 };
      windows.set(key, window);
      if (windows.size > maxTrackedKeys) {
        // Map iteration follows insertion order: evict the oldest window.
        const oldest = windows.keys().next();
        if (oldest.done !== true) windows.delete(oldest.value);
      }
    }
    if (window.count >= limit) {
      throw new EngineError({
        code: "EXECUTION_FAILED",
        message: "Capability rate limit exceeded.",
        publicDetails: {
          reason: "RATE_LIMITED",
          retryAfterMs: window.startedAt + windowMs - at,
        },
      });
    }
    window.count += 1;
    return next();
  };
}
// --- end recipe ----------------------------------------------------------

// --- recipe: result cache ------------------------------------------------
// import { createHash } from "node:crypto";
// import type { CapabilityMiddleware } from "@invokta/core";

export interface ResultCacheOptions {
  /** Only these read-only capabilities are cached. */
  readonly capabilityIds: ReadonlySet<string>;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
}

export function createResultCache(
  options: ResultCacheOptions,
): CapabilityMiddleware {
  const { capabilityIds, ttlMs, maxEntries, now = Date.now } = options;
  assertPositiveInteger("ttlMs", ttlMs);
  assertPositiveInteger("maxEntries", maxEntries);
  const entries = new Map<string, { expiresAt: number; output: unknown }>();

  return async ({ capabilityId, input, context, next }) => {
    if (!capabilityIds.has(capabilityId)) return next();
    // `access` already ran for this caller. Keying by principal keeps one
    // caller's result from being served to another.
    const key = createHash("sha256")
      .update(
        JSON.stringify([capabilityId, context.principal?.id ?? null, input]),
      )
      .digest("base64url");
    const at = now();
    const hit = entries.get(key);
    if (hit !== undefined && hit.expiresAt > at) {
      return structuredClone(hit.output);
    }
    entries.delete(key);

    const output = await next();
    entries.set(key, {
      expiresAt: at + ttlMs,
      output: structuredClone(output),
    });
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done !== true) entries.delete(oldest.value);
    }
    return output;
  };
}
// --- end recipe ----------------------------------------------------------

const secretMarker = "recipe-secret-payload-marker";

function lookupCapability(
  run = vi.fn(async ({ input }: { readonly input: { query: string } }) => ({
    answer: `${input.query}:${secretMarker}`,
  })),
  access: AnyCapability["access"] = "public",
) {
  return {
    run,
    capability: defineCapability({
      description: "Look up an answer.",
      input: z.object({ query: z.string() }),
      output: z.object({ answer: z.string() }),
      access: access as "public",
      annotations: { readOnly: true },
      run,
    }) as AnyCapability,
  };
}

const kbLookup = lookupCapability();
const kbSearch = lookupCapability();
const local = { "kb.lookup": kbLookup.capability };
const imports = [
  importCapability(
    defineExportedCapability({
      source: { name: "@community/knowledge-base", version: "1.0.0" },
      defaultId: "kb.search",
      capability: kbSearch.capability,
    }),
  ),
] as const;

// --- recipe: composition root --------------------------------------------
// import { applyMiddleware, composeCapabilities } from "@invokta/core";

const rateLimit = createRateLimit({
  limit: 60,
  windowMs: 60_000,
  maxTrackedKeys: 10_000,
});
const cache = createResultCache({
  capabilityIds: new Set(["kb.lookup"]),
  ttlMs: 30_000,
  maxEntries: 1_000,
});

export const capabilities = applyMiddleware(
  composeCapabilities({ local, imports }),
  auditLog,
  rateLimit,
  cache,
);
// --- end recipe ----------------------------------------------------------

function recordingLogger(): EngineLogger & {
  readonly entries: Array<{ message: string; details: unknown }>;
} {
  const entries: Array<{ message: string; details: unknown }> = [];
  const record = (message: string, details?: unknown): void => {
    entries.push({ message, details });
  };
  return { entries, debug: record, info: record, warn: record, error: record };
}

describe("timing recipe", () => {
  it("logs the capability and duration without payloads", async () => {
    const logger = recordingLogger();
    const engine = createEngine({
      name: "timing-engine",
      version: "1.0.0",
      logger,
      capabilities: applyMiddleware(
        { "kb.lookup": lookupCapability().capability },
        timing,
      ),
    });

    await engine.invoke("kb.lookup", { query: secretMarker });

    expect(logger.entries).toEqual([
      {
        message: "capability.timing",
        details: { capabilityId: "kb.lookup", durationMs: expect.any(Number) },
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(secretMarker);
  });
});

describe("composition root recipe", () => {
  it("audits every execution, rate-limits it, and serves cached reads in that order", async () => {
    const logger = recordingLogger();
    const engine = createEngine({
      name: "composition-root-engine",
      version: "1.0.0",
      logger,
      capabilities,
    });
    const alice = { principal: { id: "user:alice" } };

    expect(isComposedCapabilities(capabilities)).toBe(true);
    const first = await engine.invoke("kb.lookup", { query: "a" }, alice);
    await expect(
      engine.invoke("kb.lookup", { query: "a" }, alice),
    ).resolves.toEqual(first);
    await engine.invoke("kb.search", { query: "a" }, alice);
    await engine.invoke("kb.search", { query: "a" }, alice);

    expect(kbLookup.run).toHaveBeenCalledOnce();
    expect(kbSearch.run).toHaveBeenCalledTimes(2);
    expect(
      logger.entries.map(
        ({ details }) => (details as { capabilityId: string }).capabilityId,
      ),
    ).toEqual(["kb.lookup", "kb.lookup", "kb.search", "kb.search"]);
  });
});

describe("audit log recipe", () => {
  it("records one payload-free entry per executed invocation", async () => {
    const logger = recordingLogger();
    const { capability } = lookupCapability();
    const denied = lookupCapability(undefined, "authenticated");
    const failing = lookupCapability(
      vi.fn(async () => {
        throw new EngineError({
          code: "EXECUTION_FAILED",
          message: "Upstream unavailable.",
        });
      }),
    );
    const engine = createEngine({
      name: "audit-engine",
      version: "1.0.0",
      logger,
      capabilities: applyMiddleware(
        {
          "kb.lookup": capability,
          "kb.private": denied.capability,
          "kb.failing": failing.capability,
        },
        auditLog,
      ),
    });

    await engine.invoke(
      "kb.lookup",
      { query: secretMarker },
      { requestId: "request-1", source: "cli", principal: { id: "user:1" } },
    );
    await expect(
      engine.invoke("kb.private", { query: secretMarker }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      engine.invoke("kb.failing", { query: "x" }, { requestId: "request-3" }),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });

    expect(logger.entries).toHaveLength(2);
    expect(logger.entries[0]).toEqual({
      message: "capability.audit",
      details: {
        capabilityId: "kb.lookup",
        requestId: "request-1",
        source: "cli",
        principalId: "user:1",
        outcome: "returned",
        durationMs: expect.any(Number),
      },
    });
    expect(logger.entries[1]?.details).toMatchObject({
      capabilityId: "kb.failing",
      requestId: "request-3",
      principalId: null,
      outcome: "threw",
      code: "EXECUTION_FAILED",
    });
    expect(JSON.stringify(logger.entries)).not.toContain(secretMarker);
  });
});

describe("rate limit recipe", () => {
  it("raises a sanitized error per principal and capability until the window resets", async () => {
    let clock = 1_000;
    const { capability, run } = lookupCapability();
    const engine = createEngine({
      name: "rate-limit-engine",
      version: "1.0.0",
      capabilities: applyMiddleware(
        { "kb.lookup": capability },
        createRateLimit({
          limit: 2,
          windowMs: 60_000,
          maxTrackedKeys: 100,
          now: () => clock,
        }),
      ),
    });
    const alice = { principal: { id: "user:alice" } };
    const bob = { principal: { id: "user:bob" } };

    await engine.invoke("kb.lookup", { query: "a" }, alice);
    await engine.invoke("kb.lookup", { query: "b" }, alice);
    clock += 15_000;
    const rejection = engine.invoke("kb.lookup", { query: "c" }, alice);

    await expect(rejection).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Capability rate limit exceeded.",
      publicDetails: { reason: "RATE_LIMITED", retryAfterMs: 45_000 },
    });
    const error = await rejection.catch((caught: unknown) => caught);
    expect(JSON.stringify(error)).not.toContain("alice");
    expect(run).toHaveBeenCalledTimes(2);

    await expect(
      engine.invoke("kb.lookup", { query: "d" }, bob),
    ).resolves.toEqual({ answer: `d:${secretMarker}` });

    clock += 45_000;
    await expect(
      engine.invoke("kb.lookup", { query: "e" }, alice),
    ).resolves.toEqual({ answer: `e:${secretMarker}` });
  });

  it("bounds tracked keys by evicting the oldest window", async () => {
    const { capability } = lookupCapability();
    const engine = createEngine({
      name: "rate-limit-bound-engine",
      version: "1.0.0",
      capabilities: applyMiddleware(
        { "kb.lookup": capability },
        createRateLimit({
          limit: 1,
          windowMs: 60_000,
          maxTrackedKeys: 1,
          now: () => 0,
        }),
      ),
    });
    const first = { principal: { id: "user:first" } };
    const second = { principal: { id: "user:second" } };

    await engine.invoke("kb.lookup", { query: "a" }, first);
    await engine.invoke("kb.lookup", { query: "a" }, second);
    // The first window was evicted, so the bound trades accuracy for memory.
    await expect(
      engine.invoke("kb.lookup", { query: "a" }, first),
    ).resolves.toBeDefined();
  });

  it.each([
    ["limit", { limit: 0, windowMs: 1, maxTrackedKeys: 1 }],
    ["windowMs", { limit: 1, windowMs: 1.5, maxTrackedKeys: 1 }],
    ["maxTrackedKeys", { limit: 1, windowMs: 1, maxTrackedKeys: Number.NaN }],
  ])("rejects an invalid %s option", (name, options) => {
    expect(() => createRateLimit(options)).toThrow(
      new TypeError(`${name} must be a positive safe integer.`),
    );
  });
});

describe("result cache recipe", () => {
  it("serves repeated reads from memory per principal, input, and TTL", async () => {
    let clock = 0;
    const lookup = lookupCapability();
    const uncached = lookupCapability();
    const engine = createEngine({
      name: "cache-engine",
      version: "1.0.0",
      capabilities: applyMiddleware(
        { "kb.lookup": lookup.capability, "kb.live": uncached.capability },
        createResultCache({
          capabilityIds: new Set(["kb.lookup"]),
          ttlMs: 1_000,
          maxEntries: 100,
          now: () => clock,
        }),
      ),
    });
    const alice = { principal: { id: "user:alice" } };
    const bob = { principal: { id: "user:bob" } };

    const first = await engine.invoke("kb.lookup", { query: "a" }, alice);
    await expect(
      engine.invoke("kb.lookup", { query: "a" }, alice),
    ).resolves.toEqual(first);
    expect(lookup.run).toHaveBeenCalledTimes(1);

    await engine.invoke("kb.lookup", { query: "a" }, bob);
    await engine.invoke("kb.lookup", { query: "b" }, alice);
    expect(lookup.run).toHaveBeenCalledTimes(3);

    clock += 1_000;
    await engine.invoke("kb.lookup", { query: "a" }, alice);
    expect(lookup.run).toHaveBeenCalledTimes(4);

    await engine.invoke("kb.live", { query: "a" }, alice);
    await engine.invoke("kb.live", { query: "a" }, alice);
    expect(uncached.run).toHaveBeenCalledTimes(2);
  });

  it("bounds memory by evicting the oldest entry", async () => {
    const lookup = lookupCapability();
    const engine = createEngine({
      name: "cache-bound-engine",
      version: "1.0.0",
      capabilities: applyMiddleware(
        { "kb.lookup": lookup.capability },
        createResultCache({
          capabilityIds: new Set(["kb.lookup"]),
          ttlMs: 60_000,
          maxEntries: 1,
          now: () => 0,
        }),
      ),
    });

    await engine.invoke("kb.lookup", { query: "a" });
    await engine.invoke("kb.lookup", { query: "b" });
    await engine.invoke("kb.lookup", { query: "a" });
    expect(lookup.run).toHaveBeenCalledTimes(3);
  });

  it("still validates a cached result against the output schema", async () => {
    const run = vi.fn(async () => ({ answer: 42 }) as unknown as never);
    const lookup = lookupCapability(run);
    const engine = createEngine({
      name: "cache-validation-engine",
      version: "1.0.0",
      capabilities: applyMiddleware(
        { "kb.lookup": lookup.capability },
        createResultCache({
          capabilityIds: new Set(["kb.lookup"]),
          ttlMs: 60_000,
          maxEntries: 10,
        }),
      ),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        engine.invoke("kb.lookup", { query: "a" }),
      ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
    }
    expect(run).toHaveBeenCalledOnce();
  });
});
