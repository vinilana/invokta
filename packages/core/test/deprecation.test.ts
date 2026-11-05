import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AnyCapability,
  createEngine,
  defineCapability,
  type EngineEvent,
  type EngineLogger,
} from "../src/index.js";

const input = z.object({ value: z.string() });
const output = z.object({ result: z.string() });

function capability(
  overrides: Partial<Record<keyof AnyCapability, unknown>> = {},
): AnyCapability {
  return {
    description: "Echo a value.",
    input,
    output,
    access: "public",
    async run({ input: value }: { input: { value: string } }) {
      return { result: value.value };
    },
    ...overrides,
  } as unknown as AnyCapability;
}

function createLogger() {
  return {
    debug: vi.fn<EngineLogger["debug"]>(),
    info: vi.fn<EngineLogger["info"]>(),
    warn: vi.fn<
      (
        ...args: Parameters<EngineLogger["warn"]>
      ) => ReturnType<EngineLogger["warn"]> | Promise<void>
    >(),
    error: vi.fn<EngineLogger["error"]>(),
  };
}

describe("capability deprecation metadata", () => {
  it("publishes deprecation metadata through list and describe", () => {
    const engine = createEngine({
      name: "deprecation-engine",
      version: "2.0.0",
      capabilities: {
        "support.classify": capability({
          deprecated: {
            reason: "Superseded by the triage flow.",
            since: "2.0.0",
            replacement: "support.triage",
          },
        }),
        "support.triage": capability(),
      },
    });

    expect(engine.list()).toEqual([
      {
        id: "support.classify",
        description: "Echo a value.",
        deprecated: {
          reason: "Superseded by the triage flow.",
          since: "2.0.0",
          replacement: "support.triage",
        },
      },
      { id: "support.triage", description: "Echo a value." },
    ]);
    const described = engine.describe("support.classify");
    expect(described.deprecated).toEqual({
      reason: "Superseded by the triage flow.",
      since: "2.0.0",
      replacement: "support.triage",
    });
    expect(Object.isFrozen(described.deprecated)).toBe(true);
    expect(Object.isFrozen(engine.list()[0]?.deprecated)).toBe(true);
    expect(Object.hasOwn(engine.describe("support.triage"), "deprecated")).toBe(
      false,
    );
  });

  it("accepts a reason without optional fields", () => {
    const engine = createEngine({
      name: "deprecation-engine",
      version: "1.0.0",
      capabilities: {
        legacy: capability({
          deprecated: { reason: "Use the v2 engine." },
        }),
      },
    });

    expect(engine.describe("legacy").deprecated).toEqual({
      reason: "Use the v2 engine.",
    });
  });

  it("treats explicitly undefined optional deprecation fields as absent", () => {
    const engine = createEngine({
      name: "deprecation-engine",
      version: "1.0.0",
      capabilities: {
        legacy: capability({
          deprecated: {
            reason: "Retired.",
            since: undefined,
            replacement: undefined,
          },
        }),
      },
    });

    const deprecated = engine.describe("legacy").deprecated;
    expect(deprecated).toEqual({ reason: "Retired." });
    expect(Object.keys(deprecated ?? {})).toEqual(["reason"]);
  });

  it("copies deprecation metadata away from the definition", () => {
    const deprecated = {
      reason: "Original reason.",
      since: "1.0.0",
    };
    const engine = createEngine({
      name: "deprecation-engine",
      version: "1.0.0",
      capabilities: { legacy: capability({ deprecated }) },
    });

    deprecated.reason = "Mutated reason.";
    deprecated.since = "9.9.9";

    expect(engine.describe("legacy").deprecated).toEqual({
      reason: "Original reason.",
      since: "1.0.0",
    });
    expect(engine.list()[0]?.deprecated).toEqual({
      reason: "Original reason.",
      since: "1.0.0",
    });
  });

  it("accepts metadata at each inclusive length boundary", () => {
    const engine = createEngine({
      name: "deprecation-engine",
      version: "1.0.0",
      capabilities: {
        legacy: capability({
          deprecated: {
            reason: "r".repeat(1_024),
            since: "s".repeat(64),
            replacement: "x".repeat(256),
          },
        }),
      },
    });

    expect(engine.describe("legacy").deprecated).toEqual({
      reason: "r".repeat(1_024),
      since: "s".repeat(64),
      replacement: "x".repeat(256),
    });
  });

  it.each([
    ["a string", "Deprecated."],
    ["true", true],
    ["null", null],
    ["an array", ["Deprecated."]],
    ["a class instance", new (class Deprecation {})()],
    ["a missing reason", {}],
    ["an empty reason", { reason: "" }],
    ["a whitespace reason", { reason: " \n\t" }],
    ["a non-string reason", { reason: 1 }],
    ["an oversized reason", { reason: "r".repeat(1_025) }],
    ["an empty since", { reason: "Retired.", since: "" }],
    ["a non-string since", { reason: "Retired.", since: 2 }],
    ["an oversized since", { reason: "Retired.", since: "s".repeat(65) }],
    ["an empty replacement", { reason: "Retired.", replacement: " " }],
    ["a non-string replacement", { reason: "Retired.", replacement: {} }],
    [
      "an oversized replacement",
      { reason: "Retired.", replacement: "x".repeat(257) },
    ],
    ["an unsupported field", { reason: "Retired.", removal: "3.0.0" }],
    [
      "a symbol-keyed field",
      { reason: "Retired.", [Symbol("hidden")]: "value" },
    ],
  ])("rejects %s as deprecation metadata at construction", (_case, value) => {
    expect(() =>
      createEngine({
        name: "deprecation-engine",
        version: "1.0.0",
        capabilities: { legacy: capability({ deprecated: value }) },
      }),
    ).toThrow(TypeError);
  });

  it("names the capability and the bound in validation failures", () => {
    expect(() =>
      createEngine({
        name: "deprecation-engine",
        version: "1.0.0",
        capabilities: {
          legacy: capability({ deprecated: { reason: "r".repeat(1_025) } }),
        },
      }),
    ).toThrow(
      "Capability legacy deprecated.reason must be a non-blank string of at most 1024 characters.",
    );
  });

  it("rejects accessor-backed and proxy metadata without invoking it", () => {
    const getter = vi.fn(() => "Retired.");
    const accessorBacked = Object.defineProperty({}, "reason", {
      enumerable: true,
      get: getter,
    });
    const trap = vi.fn(() => "Retired.");
    const proxied = new Proxy({ reason: "Retired." }, { get: trap });
    const nonEnumerable = Object.defineProperty({}, "reason", {
      enumerable: false,
      value: "Retired.",
    });

    for (const deprecated of [accessorBacked, proxied, nonEnumerable]) {
      expect(() =>
        createEngine({
          name: "deprecation-engine",
          version: "1.0.0",
          capabilities: { legacy: capability({ deprecated }) },
        }),
      ).toThrow(TypeError);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });

  it("does not change invocation results or events", async () => {
    const events: EngineEvent[] = [];
    const engine = createEngine({
      name: "deprecation-engine",
      version: "1.0.0",
      capabilities: {
        legacy: capability({ deprecated: { reason: "Retired." } }),
      },
      onEvent(event) {
        events.push(event);
      },
    });

    await expect(
      engine.invoke("legacy", { value: "same" }, { requestId: "request-1" }),
    ).resolves.toEqual({ result: "same" });
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "invocation.completed",
    ]);
    expect(events[0]).not.toHaveProperty("deprecated");
  });

  it("logs one warning per deprecated capability through the engine logger", async () => {
    const logger = createLogger();
    const engine = createEngine({
      name: "deprecation-engine",
      version: "1.0.0",
      logger,
      capabilities: {
        legacy: capability({
          deprecated: {
            reason: "Retired.",
            since: "1.0.0",
            replacement: "current",
          },
        }),
        older: capability({ deprecated: { reason: "Retired." } }),
        current: capability(),
      },
    });

    expect(logger.warn).not.toHaveBeenCalled();
    await engine.invoke("legacy", { value: "a" }, { requestId: "request-1" });
    await engine.invoke("legacy", { value: "b" }, { requestId: "request-2" });
    await expect(
      engine.invoke("legacy", { value: 3 } as never),
    ).rejects.toThrow("Capability input validation failed.");
    await engine.invoke("current", { value: "c" });
    await engine.invoke("older", { value: "d" }, { requestId: "request-3" });

    expect(logger.warn.mock.calls).toEqual([
      [
        "Deprecated capability invoked.",
        {
          capabilityId: "legacy",
          requestId: "request-1",
          since: "1.0.0",
          replacement: "current",
        },
      ],
      [
        "Deprecated capability invoked.",
        { capabilityId: "older", requestId: "request-3" },
      ],
    ]);
  });

  it("warns before input validation so rejected calls are still visible", async () => {
    const logger = createLogger();
    const engine = createEngine({
      name: "deprecation-engine",
      version: "1.0.0",
      logger,
      capabilities: {
        legacy: capability({ deprecated: { reason: "Retired." } }),
      },
    });

    await expect(
      engine.invoke("legacy", { value: 3 } as never, { requestId: "bad" }),
    ).rejects.toThrow("Capability input validation failed.");
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Deprecated capability invoked.", {
      capabilityId: "legacy",
      requestId: "bad",
    });
  });

  it("contains a throwing or rejecting deprecation logger", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const throwing = createLogger();
      throwing.warn.mockImplementation(() => {
        throw new Error("logger unavailable");
      });
      const rejecting = createLogger();
      rejecting.warn.mockImplementation(() =>
        Promise.reject(new Error("logger unavailable")),
      );

      for (const logger of [throwing, rejecting]) {
        const engine = createEngine({
          name: "deprecation-engine",
          version: "1.0.0",
          logger,
          capabilities: {
            legacy: capability({ deprecated: { reason: "Retired." } }),
          },
        });
        await expect(
          engine.invoke("legacy", { value: "safe" }),
        ).resolves.toEqual({ result: "safe" });
        expect(logger.warn).toHaveBeenCalledOnce();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("capability access kind", () => {
  it("describes the declared access kind without exposing the rule", () => {
    const rule = vi.fn(() => true);
    const engine = createEngine({
      name: "access-kind-engine",
      version: "1.0.0",
      capabilities: {
        open: capability({ access: "public" }),
        signedIn: capability({ access: "authenticated" }),
        custom: capability({ access: rule }),
      },
    });

    expect(engine.describe("open").access).toBe("public");
    expect(engine.describe("signedIn").access).toBe("authenticated");
    expect(engine.describe("custom").access).toBe("function");
    expect(rule).not.toHaveBeenCalled();
    expect(engine.list().every((summary) => !("access" in summary))).toBe(true);
  });

  it("keeps defineCapability inference for deprecated definitions", async () => {
    const legacy = defineCapability({
      description: "Typed legacy capability.",
      input,
      output,
      access: "public",
      deprecated: { reason: "Retired.", since: "1.1.0" },
      async run({ input: value }) {
        return { result: value.value };
      },
    });
    const engine = createEngine({
      name: "typed-deprecation-engine",
      version: "1.1.0",
      capabilities: { legacy },
    });

    await expect(engine.invoke("legacy", { value: "typed" })).resolves.toEqual({
      result: "typed",
    });
  });
});
