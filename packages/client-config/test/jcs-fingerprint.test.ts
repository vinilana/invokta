import { describe, expect, it } from "vitest";

import { InstallerError } from "../src/installer-error.js";
import {
  canonicalizeJcs,
  fingerprintNormalizedDefinition,
} from "../src/jcs-fingerprint.js";

describe("RFC 8785 JSON canonicalization and fingerprints", () => {
  it("uses ECMAScript number rendering, UTF-16 key order, and preserves array order", () => {
    expect(
      canonicalizeJcs({
        string: '€$\u000f\nA\'B"\\"/',
        numbers: [Number("333333333.33333329"), 1e30, 4.5, 0.002, 1e-27, -0],
        literals: [null, true, false],
      }),
    ).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}',
    );
    expect(canonicalizeJcs({ "😀": 1, "€": 2, "\r": 3, "1": 4 })).toBe(
      '{"\\r":3,"1":4,"€":2,"😀":1}',
    );
    expect(canonicalizeJcs({ "\ue000": "bmp", "\u{10000}": "astral" })).toBe(
      '{"𐀀":"astral","":"bmp"}',
    );
  });

  it("matches the fixed Unicode SHA-256 golden", () => {
    const definition = {
      type: "stdio",
      nested: { z: "雪", a: "€" },
      env: { É: "TOKEN", "x-é": "OTHER" },
      command: "mcp-😀",
    };

    expect(fingerprintNormalizedDefinition(definition, "detached")).toBe(
      "f8be5a1461cb06197f24d29ffef1126c571ec4d5a7b34346d90784b09833d843",
    );
  });

  it("excludes only the strategy's top-level native toggle field", () => {
    const enabled = {
      type: "stdio",
      command: "engine-mcp",
      enabled: true,
      nested: { enabled: true },
    };
    const disabled = { ...enabled, enabled: false };

    expect(fingerprintNormalizedDefinition(enabled, "native-enabled")).toBe(
      fingerprintNormalizedDefinition(disabled, "native-enabled"),
    );
    expect(fingerprintNormalizedDefinition(enabled, "detached")).not.toBe(
      fingerprintNormalizedDefinition(disabled, "detached"),
    );
    expect(fingerprintNormalizedDefinition(enabled, "native-enabled")).not.toBe(
      fingerprintNormalizedDefinition(
        { ...enabled, nested: { enabled: false } },
        "native-enabled",
      ),
    );
  });

  it.each([
    ["missing", { type: "stdio", command: "engine-mcp" }],
    ["wrong type", { type: "stdio", command: "engine-mcp", enabled: "yes" }],
    [
      "non-enumerable",
      Object.defineProperty(
        { type: "stdio", command: "engine-mcp" },
        "enabled",
        {
          enumerable: false,
          value: true,
        },
      ),
    ],
    [
      "accessor",
      Object.defineProperty(
        { type: "stdio", command: "engine-mcp" },
        "enabled",
        {
          enumerable: true,
          get: () => true,
        },
      ),
    ],
  ])(
    "requires an own enumerable boolean data toggle before omitting it: %s",
    (_name, definition) => {
      expect(() =>
        fingerprintNormalizedDefinition(definition, "native-enabled"),
      ).toThrowError(
        expect.objectContaining({ code: "HARNESS_CONFIG_INVALID" }),
      );
    },
  );

  it.each([
    ["NaN", { value: Number.NaN }],
    ["positive infinity", { value: Number.POSITIVE_INFINITY }],
    ["negative infinity", { value: Number.NEGATIVE_INFINITY }],
    ["undefined", { value: undefined }],
    ["bigint", { value: 1n }],
    ["lone high surrogate", { value: "\ud800" }],
    ["lone low surrogate key", { "\udc00": true }],
    ["non-JSON object", { value: new Date(0) }],
  ])(
    "rejects the non-JCS case %s with a sanitized boundary error",
    (_name, value) => {
      let error: unknown;
      try {
        fingerprintNormalizedDefinition(value, "detached");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(InstallerError);
      expect(error).toMatchObject({ code: "HARNESS_CONFIG_INVALID" });
      expect(String(error)).not.toContain(String(value));
    },
  );

  it("rejects cycles and accessors without evaluating the accessor", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let reads = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return "JCS_SECRET_SENTINEL";
      },
    });

    expect(() => fingerprintNormalizedDefinition(cyclic, "detached")).toThrow(
      InstallerError,
    );
    expect(() => fingerprintNormalizedDefinition(accessor, "detached")).toThrow(
      InstallerError,
    );
    expect(reads).toBe(0);
  });

  it("rejects an array accessor without evaluating it", () => {
    let reads = 0;
    const array = ["safe"];
    Object.defineProperty(array, "0", {
      enumerable: true,
      get() {
        reads += 1;
        return "JCS_ARRAY_SECRET_SENTINEL";
      },
    });

    expect(() =>
      fingerprintNormalizedDefinition({ array }, "detached"),
    ).toThrow(InstallerError);
    expect(reads).toBe(0);
  });
});
