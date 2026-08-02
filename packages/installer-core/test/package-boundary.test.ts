import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function sourceFiles() {
  const sourceDirectory = `${packageDirectory}/src`;
  return readdirSync(sourceDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => ({
      name: entry.name,
      text: readFileSync(`${entry.parentPath}/${entry.name}`, "utf8"),
    }));
}

describe("@invokta/installer-core package boundary", () => {
  it("publishes an import API and no executable", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);

    expect(manifest).toMatchObject({
      name: "@invokta/installer-core",
      version: "0.3.0",
      type: "module",
      sideEffects: false,
      engines: { node: ">=22.20.0" },
      files: ["dist", "registry"],
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./errors": {
          types: "./dist/errors.d.ts",
          import: "./dist/errors.js",
        },
      },
      dependencies: {
        "@humanwhocodes/momoa": "3.3.10",
        "toml-eslint-parser": "1.0.3",
        yaml: "2.9.0",
      },
    });
    expect(manifest).not.toHaveProperty("bin");
  });

  it("has no dependency on an Invokta package", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);
    const dependencies = manifest.dependencies as Record<string, string>;

    expect(
      Object.keys(dependencies).filter((name) => name.startsWith("@invokta/")),
    ).toEqual([]);
  });

  it("declares the explicitly empty development registry as packed content", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);
    const registry = readJson(`${packageDirectory}/registry/capabilities.json`);

    expect(manifest.files).toEqual(["dist", "registry"]);
    expect(registry).toEqual({ schemaVersion: 1, entries: [] });
  });

  it("participates in the root TypeScript project without becoming a framework dependency", () => {
    const rootConfig = readJson(`${repositoryRoot}/tsconfig.json`);
    const references = rootConfig.references as { readonly path: string }[];

    expect(references).toContainEqual({ path: "./packages/installer-core" });
    expect(readJson(`${packageDirectory}/tsconfig.json`)).not.toHaveProperty(
      "references",
    );
  });

  it("keeps framework, terminal, process execution, and network imports outside the package", () => {
    for (const source of sourceFiles()) {
      expect(source.text, source.name).not.toMatch(
        /["']@invokta\/(?:core|cli|mcp|tooling|deploy|installer)["']/u,
      );
      expect(source.text, source.name).not.toMatch(
        /["']node:(?:child_process|dns|http|https|net|tls)["']/u,
      );
      expect(source.text, source.name).not.toContain("@clack");
    }
  });

  it("keeps the diagnostic subpath free of every configuration format parser", () => {
    const errors = readFileSync(`${packageDirectory}/src/errors.ts`, "utf8");
    const installerError = readFileSync(
      `${packageDirectory}/src/installer-error.ts`,
      "utf8",
    );

    expect(
      [...errors.matchAll(/from "([^"]+)"/gu)].map(([, from]) => from),
    ).toEqual(["./installer-error.js", "./installer-error.js"]);
    expect(installerError).not.toMatch(/^import /mu);
  });

  it("keeps the configuration adapters free of ambient process and filesystem access", () => {
    const adapterNames = [
      "json5-target-adapter.ts",
      "json-target-adapter.ts",
      "target-adapter.ts",
      "target-adapters.ts",
      "toml-target-adapter.ts",
      "yaml-target-adapter.ts",
    ];
    const sources = sourceFiles();
    const adapterSources = sources.filter(({ name }) =>
      adapterNames.includes(name),
    );

    expect(adapterSources).toHaveLength(6);
    for (const source of adapterSources) {
      expect(source.text, source.name).not.toMatch(
        /node:(?:child_process|fs|process)|process\.env|globalThis\.(?:fetch|WebSocket)/u,
      );
    }
    const json5Adapter = adapterSources.find(
      ({ name }) => name === "json5-target-adapter.ts",
    );
    expect(json5Adapter?.text).not.toContain('from "json5"');
    expect(json5Adapter?.text).not.toContain("JSON5.parse");
    const jsonAdapter = adapterSources.find(
      ({ name }) => name === "json-target-adapter.ts",
    );
    expect(jsonAdapter?.text).not.toContain("JSON.parse");
    expect(jsonAdapter?.text).not.toContain("evaluate(");
    expect(jsonAdapter?.text).not.toContain("tokenize(");
    const tomlAdapter = adapterSources.find(
      ({ name }) => name === "toml-target-adapter.ts",
    );
    expect(tomlAdapter?.text).not.toContain("getStaticTOMLValue");
    expect(tomlAdapter?.text).not.toContain("finishDraft");
    const yamlAdapter = adapterSources.find(
      ({ name }) => name === "yaml-target-adapter.ts",
    );
    expect(yamlAdapter?.text).not.toContain(".toJS(");
    for (const source of [
      json5Adapter,
      jsonAdapter,
      tomlAdapter,
      yamlAdapter,
    ]) {
      expect(source?.text, source?.name).not.toContain(
        "normalizedMcpDefinition",
      );
    }
  });
});
