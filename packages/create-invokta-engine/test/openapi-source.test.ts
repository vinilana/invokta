import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadOpenApiDocument } from "../src/openapi.js";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/openapi/", import.meta.url),
);

describe("loadOpenApiDocument", () => {
  it("loads equivalent OpenAPI 3.1.x JSON and YAML entry documents", async () => {
    const json = await loadOpenApiDocument({
      cwd: fixtureDirectory,
      path: "minimal.json",
    });
    const yaml = await loadOpenApiDocument({
      cwd: fixtureDirectory,
      path: "minimal.yaml",
    });

    expect(json).toEqual(yaml);
    expect(json).toMatchObject({
      openapi: "3.1.1",
      info: { title: "Minimal API", version: "1.0.0" },
      paths: { "/widgets": { get: { operationId: "listWidgets" } } },
    });
  });

  it("rejects a document outside OpenAPI 3.1.x", async () => {
    await expect(
      loadOpenApiDocument({
        cwd: fixtureDirectory,
        path: "unsupported-version.json",
      }),
    ).rejects.toMatchObject({ code: "OPENAPI_INVALID", exitCode: 2 });
  });
});
