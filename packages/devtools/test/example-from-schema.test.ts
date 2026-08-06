import { describe, expect, it } from "vitest";

import { exampleFromSchema } from "../src/ui/example-from-schema.js";
import { parseMcpResponse } from "../src/ui/mcp-response.js";

describe("exampleFromSchema", () => {
  it("builds an object example from properties", () => {
    expect(
      exampleFromSchema({
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "integer" },
          active: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
        },
      }),
    ).toEqual({ name: "", count: 0, active: false, tags: [""] });
  });

  it("prefers const, default, examples, and enum seeds", () => {
    expect(exampleFromSchema({ const: "fixed" })).toBe("fixed");
    expect(exampleFromSchema({ type: "string", default: "seed" })).toBe("seed");
    expect(exampleFromSchema({ type: "number", examples: [42, 43] })).toBe(42);
    expect(exampleFromSchema({ type: "string", enum: ["low", "high"] })).toBe(
      "low",
    );
  });

  it("follows local $ref definitions and survives cycles", () => {
    const schema = {
      type: "object",
      properties: {
        kind: { $ref: "#/$defs/kind" },
        next: { $ref: "#/$defs/node" },
      },
      $defs: {
        kind: { type: "string", enum: ["leaf"] },
        node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/node" } },
        },
      },
    };

    // The recursive $ref expands once and the cycle guard stops it there.
    expect(exampleFromSchema(schema)).toEqual({
      kind: "leaf",
      next: { next: null },
    });
  });

  it("takes the first branch of anyOf and oneOf", () => {
    expect(
      exampleFromSchema({
        anyOf: [{ type: "string" }, { type: "number" }],
      }),
    ).toBe("");
    expect(
      exampleFromSchema({
        oneOf: [{ type: "boolean" }, { type: "string" }],
      }),
    ).toBe(false);
  });

  it("seeds realistic strings for known formats", () => {
    expect(exampleFromSchema({ type: "string", format: "email" })).toBe(
      "user@example.com",
    );
    expect(exampleFromSchema({ type: "string", format: "date-time" })).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(exampleFromSchema({ type: "string", format: "uri" })).toBe(
      "https://example.com",
    );
    expect(exampleFromSchema({ type: "string", format: "hostname" })).toBe("");
  });

  it("honors minimum, minLength, and minItems with minimal valid values", () => {
    expect(exampleFromSchema({ type: "string", minLength: 3 })).toBe("xxx");
    expect(exampleFromSchema({ type: "number", minimum: 5 })).toBe(5);
    expect(exampleFromSchema({ type: "integer", minimum: 2.5 })).toBe(3);
    expect(
      exampleFromSchema({
        type: "array",
        minItems: 2,
        items: { type: "string" },
      }),
    ).toEqual(["", ""]);
    expect(exampleFromSchema({ type: "array", minItems: 2 })).toEqual([
      null,
      null,
    ]);
  });

  it("bounds an extreme minLength and minItems from an attached server", () => {
    // The seed is something a developer edits, so an absurd minimum from a
    // third-party schema must not build a multi-megabyte value.
    const text = exampleFromSchema({ type: "string", minLength: 5e7 });
    expect(typeof text).toBe("string");
    expect((text as string).length).toBe(64);

    const list = exampleFromSchema({
      type: "array",
      minItems: 2e6,
      items: { type: "string" },
    });
    expect(list).toEqual(["", "", ""]);

    expect(exampleFromSchema({ type: "array", minItems: 2e6 })).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("returns null for unusable input", () => {
    expect(exampleFromSchema(undefined)).toBeNull();
    expect(exampleFromSchema("not-a-schema")).toBeNull();
    expect(exampleFromSchema({})).toBeNull();
  });
});

describe("parseMcpResponse", () => {
  it("parses a plain JSON body", () => {
    const parsed = parseMcpResponse(
      "application/json",
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    );

    expect(parsed.message).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });

  it("parses the last data frame of an SSE body", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":0,"result":{"partial":true}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"final":true}}',
      "",
    ].join("\n");

    const parsed = parseMcpResponse("text/event-stream", body);

    expect(parsed.message).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { final: true },
    });
    expect(parsed.raw).toBe(body);
  });

  it("keeps the raw body when nothing parses", () => {
    expect(parseMcpResponse("application/json", "not json").message).toBe(
      undefined,
    );
    expect(parseMcpResponse("text/event-stream", ": ping\n\n").message).toBe(
      undefined,
    );
  });
});
