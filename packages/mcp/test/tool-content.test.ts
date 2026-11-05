import {
  createEngine,
  defineCapability,
  type EngineJsonSchema,
} from "@invokta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validateMcpToolCatalog } from "../src/index.js";
import {
  createMcpToolResult,
  diagnoseMcpToolContent,
  MAX_TOOL_CONTENT_BLOCKS,
  planMcpToolContent,
} from "../src/tool-content.js";

const latest = "2025-11-25";
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
  protocolVersion = latest,
) {
  return createMcpToolResult(
    planMcpToolContent(outputSchemaOf(output)),
    value,
    protocolVersion,
  );
}

function legacy(value: Readonly<Record<string, unknown>>) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function base64Media(contentMediaType: string) {
  return z.string().meta({ contentEncoding: "base64", contentMediaType });
}

const pngSchema = base64Media("image/png");
const imageObjectSchema = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  base64Data: z.string().meta({ contentEncoding: "base64" }),
});
const linkUriSchema = z.httpUrl().meta({ contentMediaType: "text/uri-list" });
const linkSchema = z.object({
  uri: linkUriSchema,
  name: z.string(),
  mimeType: z.string().optional(),
});

describe("MCP tool content plans", () => {
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
  });

  it.each([
    ["base64 without a media type", z.base64()],
    ["a media type outside the allowlist", base64Media("image/svg+xml")],
    ["a non-canonical media type spelling", base64Media("Image/PNG")],
    ["a media type with parameters", base64Media("audio/wav; codecs=1")],
    [
      "an encoding other than base64",
      z
        .string()
        .meta({ contentEncoding: "base32", contentMediaType: "image/png" }),
    ],
    ["a nullable union", pngSchema.nullable()],
    [
      "a media object with an undeclared media type",
      z.object({ mimeType: z.string(), data: z.base64() }),
    ],
    [
      "a media object with a non-allowlisted media type",
      z.object({
        mimeType: z.enum(["image/png", "image/svg+xml"]),
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
      "an ordinary object with a URI and a name",
      z.object({ uri: z.url(), name: z.string() }),
    ],
    [
      "a link marker without a name",
      z.object({ uri: linkUriSchema, mimeType: z.string() }),
    ],
    [
      "a link marker in another spelling",
      z.object({
        uri: z.url().meta({ contentMediaType: "Text/URI-List" }),
        name: z.string(),
      }),
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

  it("returns a frozen plan derived only from the output schema", () => {
    const plan = planMcpToolContent(
      outputSchemaOf(
        z.object({
          chart: pngSchema,
          link: linkSchema,
          annotatedLink: linkSchema.extend({ size: z.number() }),
        }),
      ),
    );
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.map(({ key }) => key)).toEqual([
      "chart",
      "link",
      "annotatedLink",
    ]);
  });
});

describe("MCP tool content results", () => {
  it("emits an image block and keeps the key with a placeholder", () => {
    const value = { before: png, caption: "Launch chart", after: jpeg };
    const result = present(
      z.object({
        before: pngSchema,
        caption: z.string(),
        after: base64Media("image/jpeg"),
      }),
      value,
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: '{"before":"[content 1: image/png]","caption":"Launch chart","after":"[content 2: image/jpeg]"}',
        },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: jpeg, mimeType: "image/jpeg" },
      ],
      structuredContent: value,
    });
    expect(result.structuredContent).toBe(value);
  });

  it("emits audio blocks from a statically typed base64 property", () => {
    const value = { speech: wav, transcript: "Hello." };
    expect(
      present(
        z.object({ speech: base64Media("audio/wav"), transcript: z.string() }),
        value,
      ),
    ).toEqual({
      content: [
        {
          type: "text",
          text: '{"speech":"[content 1: audio/wav]","transcript":"Hello."}',
        },
        { type: "audio", data: wav, mimeType: "audio/wav" },
      ],
      structuredContent: value,
    });
  });

  it("uses the per-result media type of a media object", () => {
    const value = { image: { mimeType: "image/jpeg", base64Data: jpeg } };
    expect(present(z.object({ image: imageObjectSchema }), value)).toEqual({
      content: [
        {
          type: "text",
          text: '{"image":{"mimeType":"image/jpeg","base64Data":"[content 1: image/jpeg]"}}',
        },
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
          text: JSON.stringify({
            images: [
              { mimeType: "image/png", base64Data: "[content 1: image/png]" },
              { mimeType: "image/jpeg", base64Data: "[content 2: image/jpeg]" },
            ],
            frames: ["[content 3: image/png]", "[content 4: image/png]"],
            empty: [],
          }),
        },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: jpeg, mimeType: "image/jpeg" },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: png, mimeType: "image/png" },
      ],
      structuredContent: value,
    });
  });

  it("emits explicitly marked resource links and keeps them in the text block", () => {
    const value = {
      report: {
        uri: "https://reports.example/q3.pdf",
        name: "q3-report",
        mimeType: "text/html; charset=utf-8",
        size: 2048,
      },
      sources: [{ uri: "http://localhost:8080/a", name: "a" }],
    };
    expect(
      present(
        z.object({
          report: linkSchema.extend({ size: z.number() }),
          sources: z.array(
            linkSchema.extend({
              uri: z.url().meta({ contentMediaType: "text/uri-list" }),
            }),
          ),
        }),
        value,
      ),
    ).toEqual({
      content: [
        { type: "text", text: JSON.stringify(value) },
        {
          type: "resource_link",
          uri: "https://reports.example/q3.pdf",
          name: "q3-report",
          mimeType: "text/html; charset=utf-8",
        },
        { type: "resource_link", uri: "http://localhost:8080/a", name: "a" },
      ],
      structuredContent: value,
    });
  });

  it("emits the normalized URL of an unambiguous link", () => {
    const schema = z.object({ link: linkSchema });
    for (const [uri, normalized] of [
      ["HTTPS://Example.ORG", "https://example.org/"],
      [
        "https://de.wikipedia.org/wiki/Größe",
        "https://de.wikipedia.org/wiki/Gr%C3%B6%C3%9Fe",
      ],
      ["https://a.example/<b>", "https://a.example/%3Cb%3E"],
      ["https://[::1]:8080/a?b=c#d", "https://[::1]:8080/a?b=c#d"],
    ] as const) {
      expect(present(schema, { link: { uri, name: "x" } }).content[1]).toEqual({
        type: "resource_link",
        uri: normalized,
        name: "x",
      });
    }
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
      "a link with another scheme",
      { link: { uri: "mailto:editor@example.org", name: "x" } },
    ],
    [
      "a link with a script URI",
      { link: { uri: "javascript:alert(1)", name: "x" } },
    ],
    [
      "a link with credentials",
      { link: { uri: "https://user:secret@a.example/", name: "x" } },
    ],
    [
      "a link with an at sign in its authority",
      { link: { uri: "https://good.example@evil.example/", name: "x" } },
    ],
    [
      "a link with a backslash",
      { link: { uri: "https://good.example\\@evil.example/", name: "x" } },
    ],
    [
      "a link with an empty authority",
      { link: { uri: "https:///evil.example/x", name: "x" } },
    ],
    [
      "a link with whitespace",
      { link: { uri: " https://a.example/", name: "x" } },
    ],
    [
      "a link with characters outside RFC 3986",
      { link: { uri: "https://a.example/x|y^z", name: "x" } },
    ],
    [
      "a link with malformed percent-encoding",
      { link: { uri: "https://a.example/%zz", name: "x" } },
    ],
    [
      "a link URI above 8,192 characters",
      {
        link: { uri: `https://a.example/${"a".repeat(8_175)}`, name: "x" },
      },
    ],
    [
      "a link URI whose normalized form exceeds 8,192 characters",
      {
        link: { uri: `https://a.example/${"<".repeat(4_000)}`, name: "x" },
      },
    ],
    [
      "a link with an empty name",
      { link: { uri: "https://a.example/", name: "" } },
    ],
    [
      "a link name above 1,024 UTF-8 bytes",
      { link: { uri: "https://a.example/", name: "é".repeat(513) } },
    ],
    [
      "a link name above 1,024 characters",
      { link: { uri: "https://a.example/", name: "a".repeat(50_000) } },
    ],
    [
      "a link with an invalid media type",
      { link: { uri: "https://a.example/", name: "x", mimeType: "pdf" } },
    ],
    [
      "a link media type above 255 characters",
      {
        link: {
          uri: "https://a.example/",
          name: "x",
          mimeType: `text/${"a".repeat(251)}`,
        },
      },
    ],
  ])(
    "keeps %s in the text block without affecting other blocks",
    (_label, invalid) => {
      const schema = z.object({
        other: pngSchema,
        chart: pngSchema.optional(),
        frames: z.array(pngSchema).optional(),
        image: imageObjectSchema.optional(),
        link: linkSchema.optional(),
      });
      const value = { other: png, ...invalid };
      expect(present(schema, value)).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...value, other: "[content 1: image/png]" }),
          },
          { type: "image", data: png, mimeType: "image/png" },
        ],
        structuredContent: value,
      });
    },
  );

  it("maps the valid elements of a list and keeps the others in the text", () => {
    const value = { frames: [png, "invalid", jpeg] };
    expect(present(z.object({ frames: z.array(pngSchema) }), value)).toEqual({
      content: [
        {
          type: "text",
          text: '{"frames":["[content 1: image/png]","invalid","[content 2: image/png]"]}',
        },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "image", data: jpeg, mimeType: "image/png" },
      ],
      structuredContent: value,
    });
  });

  it("accepts the URI and name bounds inclusively", () => {
    const uri = `https://a.example/${"a".repeat(8_174)}`;
    const name = "é".repeat(512);
    expect(uri).toHaveLength(8_192);
    expect(new TextEncoder().encode(name)).toHaveLength(1_024);
    const result = present(z.object({ link: linkSchema }), {
      link: { uri, name, mimeType: `text/${"a".repeat(250)}` },
    });
    expect(result.content[1]).toEqual({
      type: "resource_link",
      uri,
      name,
      mimeType: `text/${"a".repeat(250)}`,
    });
  });

  it(`presents at most ${String(MAX_TOOL_CONTENT_BLOCKS)} planned values per result`, () => {
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

  it.each([
    ["2024-11-05", ["text", "image"]],
    ["2025-03-26", ["text", "image", "audio"]],
    ["2025-06-18", ["text", "image", "audio", "resource_link"]],
    [latest, ["text", "image", "audio", "resource_link"]],
  ])("emits only the block types protocol %s defines", (version, types) => {
    const value = {
      chart: png,
      speech: wav,
      link: { uri: "https://a.example/", name: "a" },
    };
    const result = present(
      z.object({
        chart: pngSchema,
        speech: base64Media("audio/wav"),
        link: linkSchema,
      }),
      value,
      version,
    );
    expect(result.content.map(({ type }) => type)).toEqual(types);
    expect(result.structuredContent).toBe(value);
    if (!types.includes("audio")) {
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
        ...value,
        chart: "[content 1: image/png]",
      });
    }
  });

  it("returns the legacy result when the protocol defines none of the blocks", () => {
    const value = { link: { uri: "https://a.example/", name: "a" } };
    expect(
      present(z.object({ link: linkSchema }), value, "2024-11-05"),
    ).toEqual(legacy(value));
  });
});

describe("MCP tool content diagnostics", () => {
  function diagnose(output: z.ZodObject) {
    return diagnoseMcpToolContent(outputSchemaOf(output));
  }

  it("reports nothing for recognized or unannotated properties", () => {
    expect(
      diagnose(
        z.object({
          summary: z.string(),
          digest: z.base64(),
          chart: pngSchema,
          frames: z.array(pngSchema).max(4),
          image: imageObjectSchema,
          links: z.array(linkSchema).max(10),
          author: z.object({ uri: z.url(), name: z.string() }),
        }),
      ),
    ).toEqual([]);
  });

  it("reports annotations that come close to a recognized form", () => {
    expect(
      diagnose(
        z.object({
          jpg: base64Media("image/jpg"),
          upper: base64Media("Image/PNG"),
          parameters: base64Media("audio/wav; codecs=1"),
          svg: z.object({
            mimeType: z.enum(["image/png", "image/svg+xml"]),
            data: z.base64(),
          }),
          raw: z.string().meta({ contentMediaType: "image/png" }),
          noData: z.object({ mimeType: z.literal("image/png"), url: z.url() }),
          twoData: z.object({
            mimeType: z.literal("image/png"),
            data: z.base64(),
            thumbnail: z.base64(),
          }),
          bareLink: linkUriSchema,
          namelessLink: z.object({ uri: linkUriSchema }),
          nullable: pngSchema.nullable(),
          nested: z.object({ inner: z.object({ chart: pngSchema }) }),
          grid: z.array(z.array(pngSchema)),
        }),
      ),
    ).toEqual([
      { property: "jpg", code: "UNSUPPORTED_MEDIA_TYPE" },
      { property: "upper", code: "UNSUPPORTED_MEDIA_TYPE" },
      { property: "parameters", code: "UNSUPPORTED_MEDIA_TYPE" },
      { property: "svg", code: "UNSUPPORTED_MEDIA_TYPE" },
      { property: "raw", code: "MEDIA_WITHOUT_BASE64" },
      { property: "noData", code: "MEDIA_WITHOUT_BASE64" },
      { property: "twoData", code: "AMBIGUOUS_MEDIA_OBJECT" },
      { property: "bareLink", code: "INCOMPLETE_RESOURCE_LINK" },
      { property: "namelessLink", code: "INCOMPLETE_RESOURCE_LINK" },
      { property: "nullable", code: "UNSUPPORTED_POSITION" },
      { property: "nested", code: "UNSUPPORTED_POSITION" },
      { property: "grid", code: "UNSUPPORTED_POSITION" },
    ]);
  });

  it("reports a contract that permits more planned values than the limit", () => {
    expect(
      diagnose(z.object({ cover: pngSchema, frames: z.array(pngSchema) })),
    ).toEqual([{ property: "frames", code: "CONTENT_BLOCK_LIMIT" }]);
    expect(
      diagnose(
        z.object({
          frames: z.array(pngSchema).max(15),
          cover: pngSchema,
          back: pngSchema,
          links: z.array(linkSchema).max(4),
        }),
      ),
    ).toEqual([{ property: "back", code: "CONTENT_BLOCK_LIMIT" }]);
    expect(diagnose(z.object({ frames: z.array(pngSchema).max(16) }))).toEqual(
      [],
    );
  });
});

describe("MCP tool catalog report", () => {
  it("returns frozen, payload-free content warnings in catalog order", () => {
    const capability = (output: z.ZodObject) =>
      defineCapability({
        description: "Declares one output contract.",
        input: z.object({}),
        output: output as z.ZodObject<{ value: z.ZodOptional<z.ZodString> }>,
        access: "public",
        async run() {
          return {};
        },
      });
    const engine = createEngine({
      name: "content-report-engine",
      version: "0.1.0",
      capabilities: {
        "media.plain": capability(z.object({ ok: z.boolean() })),
        "media.render": capability(
          z.object({
            chart: base64Media("image/jpg"),
            link: z.object({ uri: linkUriSchema }),
          }),
        ),
      },
    });

    const report = validateMcpToolCatalog(engine);

    expect(report).toEqual({
      contentWarnings: [
        {
          capabilityId: "media.render",
          toolName: "media_render",
          property: "chart",
          code: "UNSUPPORTED_MEDIA_TYPE",
        },
        {
          capabilityId: "media.render",
          toolName: "media_render",
          property: "link",
          code: "INCOMPLETE_RESOURCE_LINK",
        },
      ],
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.contentWarnings)).toBe(true);
    expect(Object.isFrozen(report.contentWarnings[0])).toBe(true);
  });
});
