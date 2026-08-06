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
