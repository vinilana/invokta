import {
  createEngine,
  defineCapability,
  type EngineJsonSchema,
} from "@invokta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createMcpToolResult,
  MAX_TOOL_CONTENT_BLOCKS,
  planMcpToolContent,
} from "../src/tool-content.js";

const png = Buffer.from("png bytes").toString("base64");
const jpeg = Buffer.from("jpeg bytes").toString("base64");
const wav = Buffer.from("wav bytes").toString("base64");

function outputSchemaOf(output: z.ZodObject): EngineJsonSchema {
  const engine = createEngine({
    name: "tool-content-plan-engine",
    version: "0.1.0",
    capabilities: {
      "content.probe": defineCapability({
        description: "Describes one output contract.",
        input: z.object({}),
        output: output as z.ZodObject<{ value: z.ZodOptional<z.ZodString> }>,
        access: "public",
        async run() {
          return {};
        },
      }),
    },
  });
  return engine.describe("content.probe").outputSchema;
}

function present(
  output: z.ZodObject,
  value: Readonly<Record<string, unknown>>,
) {
  return createMcpToolResult(planMcpToolContent(outputSchemaOf(output)), value);
}

function legacy(value: Readonly<Record<string, unknown>>) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const pngSchema = z.base64().meta({ contentMediaType: "image/png" });
const imageObjectSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  base64Data: z.base64(),
});
const linkSchema = z.object({
  uri: z.url(),
  name: z.string(),
  mimeType: z.string().optional(),
});

describe("MCP tool result content", () => {
  it("keeps the legacy result byte for byte without content annotations", () => {
    const value = { summary: "ok", count: 2, nested: { data: png } };
    const result = present(
      z.object({
        summary: z.string(),
        count: z.number(),
        nested: z.object({ data: pngSchema }),
      }),
      value,
    );

    expect(result).toEqual(legacy(value));
    expect(result.structuredContent).toBe(value);
    expect(
      planMcpToolContent(
        outputSchemaOf(z.object({ summary: z.string(), count: z.number() })),
      ),
    ).toEqual([]);
  });

  it.each([
    ["base64 without a media type", z.base64()],
    [
      "a media type outside the allowlist",
      z.base64().meta({ contentMediaType: "image/svg+xml" }),
    ],
    [
      "a non-canonical media type spelling",
      z.base64().meta({ contentMediaType: "Image/PNG" }),
    ],
    [
      "a media type with parameters",
      z.base64().meta({ contentMediaType: "audio/wav; codecs=1" }),
    ],
    [
      "an encoding other than base64",
      z
        .string()
        .meta({ contentEncoding: "base32", contentMediaType: "image/png" }),
    ],
    [
      "a media type without an encoding",
      z.string().meta({ contentMediaType: "image/png" }),
    ],
    ["a nullable union", pngSchema.nullable()],
    [
      "a media object with an undeclared media type",
      z.object({ mimeType: z.string(), data: z.base64() }),
    ],
    [
      "a media object with a non-allowlisted media type",
      z.object({
        mimeType: z.enum(["image/png", "application/pdf"]),
        data: z.base64(),
      }),
    ],
    [
      "a media object with two base64 properties",
      z.object({
        mimeType: z.literal("image/png"),
        data: z.base64(),
        thumbnail: z.base64(),
      }),
    ],
    [
      "a link without a URI format",
      z.object({ uri: z.string(), name: z.string() }),
    ],
    ["a link without a name", z.object({ uri: z.url(), mimeType: z.string() })],
    [
      "a link with extra properties",
      z.object({ uri: z.url(), name: z.string(), size: z.number() }),
    ],
    ["a nested array", z.array(z.array(pngSchema))],
  ])("does not plan content for %s", (_label, schema) => {
    expect(
      planMcpToolContent(outputSchemaOf(z.object({ value: schema }))),
    ).toEqual([]);
  });

  it("does not plan content for unrecognized output roots or properties", () => {
    for (const schema of [
      { type: "object" },
      { type: "object", properties: [] },
      { anyOf: [{ type: "object", properties: { image: {} } }] },
      {
        type: "object",
        properties: { image: { $ref: "#/$defs/Image" } },
        $defs: {
          Image: {
            type: "string",
            contentEncoding: "base64",
            contentMediaType: "image/png",
          },
        },
      },
      {
        type: "object",
        properties: {
          image: {
            type: ["string"],
            contentEncoding: "base64",
            contentMediaType: "image/png",
          },
        },
      },
    ]) {
      expect(planMcpToolContent(schema)).toEqual([]);
    }
  });

  it("emits an image block and elides its base64 from the text block", () => {
    const value = { caption: "Launch chart", chart: png };
    const result = present(
      z.object({ caption: z.string(), chart: pngSchema }),
      value,
    );

    expect(result).toEqual({
      content: [
        { type: "text", text: '{"caption":"Launch chart"}' },
        { type: "image", data: png, mimeType: "image/png" },
      ],
      structuredContent: value,
    });
    expect(result.structuredContent).toBe(value);
  });

  it("emits audio blocks from a statically typed base64 property", () => {
    const value = { speech: wav, transcript: "Hello." };
    expect(
      present(
        z.object({
          speech: z.string().meta({
            contentEncoding: "base64",
            contentMediaType: "audio/wav",
          }),
          transcript: z.string(),
        }),
        value,
      ),
    ).toEqual({
      content: [
        { type: "text", text: '{"transcript":"Hello."}' },
        { type: "audio", data: wav, mimeType: "audio/wav" },
      ],
      structuredContent: value,
    });
  });

  it("uses the per-result media type of a media object", () => {
    const value = { image: { mimeType: "image/jpeg", base64Data: jpeg } };
    expect(present(z.object({ image: imageObjectSchema }), value)).toEqual({
      content: [
        { type: "text", text: '{"image":{"mimeType":"image/jpeg"}}' },
        { type: "image", data: jpeg, mimeType: "image/jpeg" },
      ],
      structuredContent: value,
    });
  });

  it("emits one block per array element in index order", () => {
    const value = {
      images: [
        { mimeType: "image/png", base64Data: png },
        { mimeType: "image/jpeg", base64Data: jpeg },
      ],
      frames: [png, png],
      empty: [],
    };
    expect(
      present(
        z.object({
          images: z.array(imageObjectSchema),
          frames: z.array(pngSchema),
          empty: z.array(pngSchema),
        }),
        value,
      ),
    ).toEqual({
      content: [
        {
          type: "text",
          text: '{"images":[{"mimeType":"image/png"},{"mimeType":"image/jpeg"}],"empty":[]}',
        },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: jpeg, mimeType: "image/jpeg" },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: png, mimeType: "image/png" },
      ],
      structuredContent: value,
    });
  });

  it("emits resource links and keeps them in the text block", () => {
    const value = {
      report: {
        uri: "https://reports.example/q3.pdf",
        name: "q3-report",
        mimeType: "application/pdf",
      },
      sources: [{ uri: "http://localhost:8080/a", name: "a" }],
    };
    expect(
      present(
        z.object({ report: linkSchema, sources: z.array(linkSchema) }),
        value,
      ),
    ).toEqual({
      content: [
        { type: "text", text: JSON.stringify(value) },
        {
          type: "resource_link",
          uri: "https://reports.example/q3.pdf",
          name: "q3-report",
          mimeType: "application/pdf",
        },
        { type: "resource_link", uri: "http://localhost:8080/a", name: "a" },
      ],
      structuredContent: value,
    });
  });

  it("orders blocks by the output schema property order", () => {
    const value = {
      link: { uri: "https://a.example/", name: "a" },
      chart: png,
    };
    const result = present(
      z.object({ chart: pngSchema, link: linkSchema }),
      value,
    );
    expect(result.content.map(({ type }) => type)).toEqual([
      "text",
      "image",
      "resource_link",
    ]);
  });

  it("returns the legacy result when no annotated value is present", () => {
    const schema = z.object({
      summary: z.string(),
      chart: pngSchema.optional(),
      frames: z.array(pngSchema),
    });
    const value = { summary: "no media", frames: [] };
    expect(present(schema, value)).toEqual(legacy(value));
  });

  it.each([
    ["non-base64 data", { chart: "not base64!" }],
    ["unpadded base64 data", { chart: "cG5nYg" }],
    ["empty data", { chart: "" }],
    ["a non-string value", { chart: 42 }],
    ["a null value", { chart: null }],
    ["a non-array list", { frames: png }],
    [
      "a media object with an undeclared media type",
      { image: { mimeType: "image/webp", base64Data: png } },
    ],
    ["a media object without data", { image: { mimeType: "image/png" } }],
    [
      "a link with a script URI",
      { link: { uri: "javascript:alert(1)", name: "x" } },
    ],
    [
      "a link with credentials",
      { link: { uri: "https://user:secret@a.example/", name: "x" } },
    ],
    [
      "a link with whitespace",
      { link: { uri: " https://a.example/", name: "x" } },
    ],
    [
      "a link with a non-ASCII URI",
      { link: { uri: "https://a.example/ação", name: "x" } },
    ],
    [
      "a link URI above 8,192 bytes",
      {
        link: { uri: `https://a.example/${"a".repeat(8_175)}`, name: "x" },
      },
    ],
    [
      "a link with an empty name",
      { link: { uri: "https://a.example/", name: "" } },
    ],
    [
      "a link name above 1,024 bytes",
      { link: { uri: "https://a.example/", name: "é".repeat(513) } },
    ],
    [
      "a link with an invalid media type",
      { link: { uri: "https://a.example/", name: "x", mimeType: "pdf" } },
    ],
  ])("falls back atomically to the legacy result for %s", (_label, invalid) => {
    const schema = z.object({
      caption: z.string(),
      chart: z
        .string()
        .meta({ contentEncoding: "base64", contentMediaType: "image/png" })
        .optional(),
      frames: z.array(pngSchema).optional(),
      image: imageObjectSchema.optional(),
      link: linkSchema.optional(),
      other: pngSchema,
    });
    const value = { caption: "fallback", other: png, ...invalid };
    expect(present(schema, value)).toEqual(legacy(value));
  });

  it("accepts the URI and name bounds inclusively", () => {
    const uri = `https://a.example/${"a".repeat(8_174)}`;
    const name = "é".repeat(512);
    expect(new TextEncoder().encode(uri)).toHaveLength(8_192);
    const result = present(z.object({ link: linkSchema }), {
      link: { uri, name },
    });
    expect(result.content[1]).toEqual({ type: "resource_link", uri, name });
  });

  it(`generates at most ${String(MAX_TOOL_CONTENT_BLOCKS)} blocks per result`, () => {
    expect(MAX_TOOL_CONTENT_BLOCKS).toBe(16);
    const schema = z.object({ cover: pngSchema, frames: z.array(pngSchema) });
    const atLimit = {
      cover: png,
      frames: Array.from({ length: 15 }, () => png),
    };
    const aboveLimit = {
      cover: png,
      frames: Array.from({ length: 16 }, () => png),
    };

    expect(present(schema, atLimit).content).toHaveLength(17);
    expect(present(schema, aboveLimit)).toEqual(legacy(aboveLimit));
  });

  it("returns a frozen plan derived only from the output schema", () => {
    const plan = planMcpToolContent(
      outputSchemaOf(z.object({ chart: pngSchema, link: linkSchema })),
    );
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan).toHaveLength(2);
  });
});
