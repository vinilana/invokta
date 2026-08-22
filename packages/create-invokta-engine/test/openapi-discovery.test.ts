import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { loadOpenApiDocument } from "../src/openapi.js";
import {
  discoverOpenApiOperations,
  type OpenApiOperationCandidate,
  selectOpenApiOperations,
} from "../src/openapi-discovery.js";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/openapi/", import.meta.url),
);

let candidates: readonly OpenApiOperationCandidate[];

function bySelector(selector: string): OpenApiOperationCandidate {
  const candidate = candidates.find((item) => item.selector === selector);
  if (candidate === undefined) {
    throw new Error(`Missing test candidate ${selector}`);
  }
  return candidate;
}

beforeAll(async () => {
  const document = await loadOpenApiDocument({
    cwd: fixtureDirectory,
    path: "discovery.yaml",
  });
  candidates = discoverOpenApiOperations(document);
});

describe("discoverOpenApiOperations", () => {
  it("discovers every standard HTTP operation in canonical selector order", () => {
    expect(candidates.map((candidate) => candidate.selector)).toEqual([
      "GET:/alias-a",
      "GET:/alias-b",
      "GET:/bad-parameter",
      "GET:/no-success",
      "GET:/oauth",
      "GET:/operation-server",
      "GET:/path-server",
      "GET:/root-server",
      "GET:/without-operation-id",
      "POST:/upload",
    ]);
    expect(bySelector("GET:/without-operation-id")).toMatchObject({
      method: "GET",
      path: "/without-operation-id",
      selector: "GET:/without-operation-id",
    });
    expect(bySelector("GET:/without-operation-id").operationId).toBeUndefined();
  });

  it("uses operation, path, then root server precedence", () => {
    expect(bySelector("GET:/operation-server").connection).toEqual({
      serverSource: "operation",
      serverUrls: ["https://operation.example.test/v3"],
    });
    expect(bySelector("GET:/path-server").connection).toEqual({
      serverSource: "path",
      serverUrls: ["https://path.example.test/v2"],
    });
    expect(bySelector("GET:/root-server").connection).toEqual({
      serverSource: "root",
      serverUrls: ["https://root.example.test/v1"],
    });
  });

  it("keeps supported operations eligible and reports one stable unsupported reason", () => {
    expect(bySelector("GET:/root-server").eligibility).toEqual({
      eligible: true,
    });
    expect(bySelector("GET:/without-operation-id").eligibility).toEqual({
      eligible: true,
    });
    expect(bySelector("GET:/bad-parameter").eligibility).toEqual({
      eligible: false,
      reason: "PARAMETER_UNSUPPORTED",
    });
    expect(bySelector("GET:/no-success").eligibility).toEqual({
      eligible: false,
      reason: "SUCCESS_RESPONSE_MISSING",
    });
    expect(bySelector("GET:/oauth").eligibility).toEqual({
      eligible: false,
      reason: "SECURITY_UNSUPPORTED",
    });
    expect(bySelector("POST:/upload").eligibility).toEqual({
      eligible: false,
      reason: "REQUEST_BODY_UNSUPPORTED",
    });
  });

  it("is deterministic for documents with a different path insertion order", async () => {
    const document = await loadOpenApiDocument({
      cwd: fixtureDirectory,
      path: "discovery.yaml",
    });
    const reversed = {
      ...document,
      paths: Object.fromEntries(Object.entries(document.paths).reverse()),
    };

    expect(discoverOpenApiOperations(reversed)).toEqual(candidates);
  });
});

describe("selectOpenApiOperations", () => {
  it("selects every eligible operation by default", () => {
    const selection = selectOpenApiOperations(candidates, []);

    expect(selection.map((candidate) => candidate.selector)).toEqual([
      "GET:/alias-a",
      "GET:/alias-b",
      "GET:/operation-server",
      "GET:/path-server",
      "GET:/root-server",
      "GET:/without-operation-id",
    ]);
  });

  it("excludes by canonical selector or unique operationId alias", () => {
    const selection = selectOpenApiOperations(candidates, [
      "GET:/without-operation-id",
      "pathServer",
      "pathServer",
    ]);

    expect(selection.map((candidate) => candidate.selector)).toEqual([
      "GET:/alias-a",
      "GET:/alias-b",
      "GET:/operation-server",
      "GET:/root-server",
    ]);
  });

  it.each([
    ["unknown selector", ["GET:/missing"]],
    ["ambiguous operationId alias", ["sharedAlias"]],
  ] as const)("rejects an %s", (_label, exclusions) => {
    expect(() => selectOpenApiOperations(candidates, exclusions)).toThrowError(
      expect.objectContaining({
        code: "OPENAPI_SELECTION_INVALID",
        exitCode: 2,
      }),
    );
  });

  it("rejects excluding every eligible operation", () => {
    const everyEligibleSelector = candidates
      .filter((candidate) => candidate.eligibility.eligible)
      .map((candidate) => candidate.selector);

    expect(() =>
      selectOpenApiOperations(candidates, everyEligibleSelector),
    ).toThrowError(
      expect.objectContaining({
        code: "OPENAPI_SELECTION_INVALID",
        exitCode: 2,
      }),
    );
  });
});
