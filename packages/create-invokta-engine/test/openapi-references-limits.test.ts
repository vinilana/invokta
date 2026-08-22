import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CreateEngineIo,
  type CreateEngineTerminal,
  type InstallProject,
  runCreateEngineCli,
} from "../src/cli.js";
import { loadOpenApiDocument, type OpenApiDocument } from "../src/openapi.js";
import {
  discoverOpenApiOperations,
  type OpenApiOperationCandidate,
} from "../src/openapi-discovery.js";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/openapi/references/", import.meta.url),
);
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-openapi-boundary-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJsonFixture(value: unknown): Readonly<{
  cwd: string;
  path: string;
}> {
  const cwd = createTemporaryDirectory();
  const path = "openapi.json";
  writeFileSync(join(cwd, path), JSON.stringify(value));
  return { cwd, path };
}

function writeLocalDocumentChain(externalDocumentCount: number): Readonly<{
  cwd: string;
  path: string;
}> {
  const cwd = createTemporaryDirectory();
  const path = "openapi.json";
  writeFileSync(
    join(cwd, path),
    JSON.stringify({
      openapi: "3.1.1",
      info: { title: "Local document limit", version: "1.0.0" },
      paths: {
        "/widgets": {
          get: {
            parameters: [{ $ref: "./reference-0.json#/Parameter" }],
            responses: { "204": { description: "No content" } },
          },
        },
      },
    }),
  );
  for (let index = 0; index < externalDocumentCount; index += 1) {
    const parameter =
      index + 1 === externalDocumentCount
        ? { name: "value", in: "query", schema: { type: "string" } }
        : { $ref: `./reference-${index + 1}.json#/Parameter` };
    writeFileSync(
      join(cwd, `reference-${index}.json`),
      JSON.stringify({ Parameter: parameter }),
    );
  }
  return { cwd, path };
}

function sameDocumentReferenceChain(
  referenceCount: number,
): Record<string, unknown> {
  const parameters = Object.fromEntries(
    Array.from({ length: referenceCount }, (_, index) => [
      `Parameter${index}`,
      index + 1 === referenceCount
        ? { name: "value", in: "query", schema: { type: "string" } }
        : { $ref: `#/components/parameters/Parameter${index + 1}` },
    ]),
  );
  return {
    openapi: "3.1.1",
    info: { title: "Reference depth limit", version: "1.0.0" },
    paths: {
      "/widgets": {
        get: {
          parameters: [{ $ref: "#/components/parameters/Parameter0" }],
          responses: { "204": { description: "No content" } },
        },
      },
    },
    components: { parameters },
  };
}

function sharedReferenceChain(referenceCount: number): Record<string, unknown> {
  const schemas = Object.fromEntries(
    Array.from({ length: referenceCount }, (_, index) => [
      `Schema${index}`,
      index + 1 === referenceCount
        ? { type: "string" }
        : {
            type: "object",
            properties: {
              left: { $ref: `#/components/schemas/Schema${index + 1}` },
              right: { $ref: `#/components/schemas/Schema${index + 1}` },
            },
          },
    ]),
  );
  return {
    openapi: "3.1.1",
    info: { title: "Shared references", version: "1.0.0" },
    paths: {},
    components: { schemas },
  };
}

function wideReferenceOverlays(
  memberCount: number,
  overlayCount: number,
): Record<string, unknown> {
  return {
    openapi: "3.1.1",
    info: { title: "Reference allocation budget", version: "1.0.0" },
    paths: {},
    components: {
      schemas: {
        Wide: Object.fromEntries(
          Array.from({ length: memberCount }, (_, index) => [
            `member${index}`,
            null,
          ]),
        ),
      },
    },
    "x-overlays": Array.from({ length: overlayCount }, (_, index) => ({
      $ref: "#/components/schemas/Wide",
      description: `Bounded shallow copy ${String(index)}.`,
    })),
  };
}

function nestedArray(levels: number): unknown {
  let value: unknown = null;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
}

function entryDocument(extension: unknown): Record<string, unknown> {
  return {
    openapi: "3.1.1",
    info: { title: "Boundary fixture", version: "1.0.0" },
    paths: {},
    "x-boundary": extension,
  };
}

function operationDocument(
  count: number,
  eligibleCount: number,
): OpenApiDocument {
  const paths = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `/operation-${index.toString().padStart(3, "0")}`,
      {
        get: {
          operationId: `operation${index}`,
          responses:
            index < eligibleCount
              ? { "204": { description: "No content" } }
              : { default: { description: "Not an explicit success" } },
        },
      },
    ]),
  );
  return {
    openapi: "3.1.1",
    info: { title: "Operation limits", version: "1.0.0" },
    paths,
  };
}

async function candidatesFrom(
  path: string,
): Promise<readonly OpenApiOperationCandidate[]> {
  const document = await loadOpenApiDocument({ cwd: fixtureDirectory, path });
  return discoverOpenApiOperations(document);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenAPI local reference boundary", () => {
  it("resolves same-document parameters, request bodies, responses, schemas, and security", async () => {
    const candidates = await candidatesFrom("same-document.yaml");

    expect(candidates).toMatchObject([
      {
        selector: "POST:/widgets/{widgetId}",
        eligibility: { eligible: true },
      },
    ]);
  });

  it("resolves contained relative references from the document that declares each reference", async () => {
    const candidates = await candidatesFrom("relative/entry.yaml");

    expect(candidates).toMatchObject([
      {
        selector: "PUT:/widgets/{widgetId}",
        eligibility: { eligible: true },
      },
    ]);
  });

  it("marks remote and absolute references ineligible with the highest-precedence reason", async () => {
    const candidates = await candidatesFrom("unsupported.yaml");

    expect(candidates).toMatchObject([
      {
        selector: "GET:/absolute",
        eligibility: {
          eligible: false,
          reason: "REFERENCE_UNSUPPORTED",
        },
      },
      {
        selector: "GET:/remote",
        eligibility: {
          eligible: false,
          reason: "REFERENCE_UNSUPPORTED",
        },
      },
      {
        selector: "GET:/supported",
        eligibility: { eligible: true },
      },
    ]);
  });

  it("does not allow a relative reference to escape the entry document directory", async () => {
    const candidates = await candidatesFrom("escape/entry.yaml");

    expect(candidates).toMatchObject([
      {
        selector: "GET:/escape",
        eligibility: {
          eligible: false,
          reason: "REFERENCE_UNSUPPORTED",
        },
      },
      {
        selector: "GET:/supported",
        eligibility: { eligible: true },
      },
    ]);
  });
});

describe("OpenAPI parser safety", () => {
  it.each([
    ["YAML aliases", "yaml-alias.yaml"],
    ["a version outside OpenAPI 3.1.x", "unsupported-version.yaml"],
  ])("rejects %s as an invalid document", async (_label, path) => {
    await expect(
      loadOpenApiDocument({ cwd: fixtureDirectory, path }),
    ).rejects.toMatchObject({ code: "OPENAPI_INVALID", exitCode: 2 });
  });

  it("accepts exactly 100,000 parsed nodes", async () => {
    // Seven structural nodes plus these scalar array members equals 100,000.
    const fixture = writeJsonFixture(entryDocument(Array(99_993).fill(null)));

    await expect(loadOpenApiDocument(fixture)).resolves.toMatchObject({
      openapi: "3.1.1",
    });
  });

  it("rejects 100,001 parsed nodes", async () => {
    const fixture = writeJsonFixture(entryDocument(Array(99_994).fill(null)));

    await expect(loadOpenApiDocument(fixture)).rejects.toMatchObject({
      code: "OPENAPI_LIMIT_EXCEEDED",
      exitCode: 1,
    });
  });

  it("accepts document depth 64 and rejects depth 65", async () => {
    // The root is depth 1; 62 nested arrays put the null leaf at depth 64.
    const atLimit = writeJsonFixture(entryDocument(nestedArray(62)));
    const overLimit = writeJsonFixture(entryDocument(nestedArray(63)));

    await expect(loadOpenApiDocument(atLimit)).resolves.toMatchObject({
      openapi: "3.1.1",
    });
    await expect(loadOpenApiDocument(overLimit)).rejects.toMatchObject({
      code: "OPENAPI_LIMIT_EXCEEDED",
      exitCode: 1,
    });
  });

  it("accepts 64 local documents and rejects a 65th document", async () => {
    const atLimit = writeLocalDocumentChain(63);
    const overLimit = writeLocalDocumentChain(64);

    await expect(loadOpenApiDocument(atLimit)).resolves.toMatchObject({
      openapi: "3.1.1",
    });
    await expect(loadOpenApiDocument(overLimit)).rejects.toMatchObject({
      code: "OPENAPI_LIMIT_EXCEEDED",
      exitCode: 1,
    });
  });

  it("accepts reference depth 64 and rejects reference depth 65", async () => {
    const atLimit = writeJsonFixture(sameDocumentReferenceChain(64));
    const overLimit = writeJsonFixture(sameDocumentReferenceChain(65));

    await expect(loadOpenApiDocument(atLimit)).resolves.toMatchObject({
      openapi: "3.1.1",
    });
    await expect(loadOpenApiDocument(overLimit)).rejects.toMatchObject({
      code: "OPENAPI_LIMIT_EXCEEDED",
      exitCode: 1,
    });
  });

  it("memoizes repeated local references instead of expanding a binary tree", async () => {
    const fixture = writeJsonFixture(sharedReferenceChain(16));
    const document = await loadOpenApiDocument(fixture);
    const schemas = (document.components as Record<string, unknown>)
      .schemas as Record<string, Record<string, unknown>>;
    const root = schemas.Schema0;
    const properties = root?.properties as Record<string, unknown>;

    expect(properties.left).toBe(properties.right);
  });

  it("rejects a reference sibling overlay before its copy crosses the resolution budget", async () => {
    const fixture = writeJsonFixture(wideReferenceOverlays(1_000, 100));

    await expect(loadOpenApiDocument(fixture)).rejects.toMatchObject({
      code: "OPENAPI_LIMIT_EXCEEDED",
      exitCode: 1,
    });
  });
});

describe("OpenAPI operation limits", () => {
  it("accepts exactly 500 discovered operations and rejects 501", () => {
    expect(discoverOpenApiOperations(operationDocument(500, 1))).toHaveLength(
      500,
    );
    expect(() =>
      discoverOpenApiOperations(operationDocument(501, 1)),
    ).toThrowError(
      expect.objectContaining({
        code: "OPENAPI_LIMIT_EXCEEDED",
        exitCode: 1,
      }),
    );
  });

  it("accepts exactly 100 eligible operations and rejects 101", () => {
    expect(discoverOpenApiOperations(operationDocument(100, 100))).toHaveLength(
      100,
    );
    expect(() =>
      discoverOpenApiOperations(operationDocument(101, 101)),
    ).toThrowError(
      expect.objectContaining({
        code: "OPENAPI_LIMIT_EXCEEDED",
        exitCode: 1,
      }),
    );
  });
});

describe("OpenAPI import with no eligible operation", () => {
  it("fails before target mutation as OPENAPI_UNSUPPORTED", async () => {
    const cwd = createTemporaryDirectory();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CreateEngineIo = {
      writeStdout(text) {
        stdout.push(text);
      },
      writeStderr(text) {
        stderr.push(text);
      },
    };
    const terminal: CreateEngineTerminal = {
      stdinIsTty: false,
      stderrIsTty: false,
      readLine: vi.fn(async () => {
        throw new Error("must not read standard input");
      }),
    };
    const install = vi.fn<InstallProject>();

    const exitCode = await runCreateEngineCli({
      argv: [
        "generated-engine",
        "--openapi",
        join(fixtureDirectory, "zero-eligible.yaml"),
        "--no-install",
      ],
      cwd,
      env: {},
      io,
      terminal,
      install,
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "OPENAPI_UNSUPPORTED: The OpenAPI document has no supported operation to import.\n",
    ]);
    expect(terminal.readLine).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, "generated-engine"))).toBe(false);
  });
});
