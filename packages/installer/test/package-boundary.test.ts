import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("@invokta/installer package boundary", () => {
  it("publishes the standalone executable and only the engine subpath export", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);

    expect(manifest).toMatchObject({
      name: "@invokta/installer",
      version: "0.9.0",
      type: "module",
      engines: { node: ">=22.20.0" },
      files: ["dist", "registry"],
      exports: {
        "./engine": {
          types: "./dist/engine-cli.d.ts",
          import: "./dist/engine-cli.js",
        },
      },
      bin: { "invokta-installer": "./dist/cli.js" },
      dependencies: {
        "@clack/prompts": "1.7.0",
        "@humanwhocodes/momoa": "3.3.10",
        "toml-eslint-parser": "1.0.3",
        yaml: "2.9.0",
      },
    });
    expect(Object.keys(manifest.exports as Record<string, unknown>)).toEqual([
      "./engine",
    ]);
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("types");
  });

  it("has no dependency on an Invokta framework or tooling package", () => {
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

    expect(references).toContainEqual({ path: "./packages/installer" });
  });

  it("keeps framework, process execution, and network imports outside the package", () => {
    const sourceDirectory = `${packageDirectory}/src`;
    const sourceFiles = readdirSync(sourceDirectory, {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
    const sources = sourceFiles.map((entry) => ({
      name: entry.name,
      text: readFileSync(`${entry.parentPath}/${entry.name}`, "utf8"),
    }));

    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(
        /["']@invokta\/(?:core|cli|mcp|tooling)["']/u,
      );
      expect(source.text, source.name).not.toMatch(
        /["']node:(?:child_process|dns|http|https|net|tls)["']/u,
      );
    }

    expect(
      sources
        .filter(({ text }) => text.includes('from "@clack/prompts"'))
        .map(({ name }) => name),
    ).toEqual(["clack-interactive-prompter.ts"]);
    expect(
      sources.find(({ name }) => name === "interactive-prompter.ts")?.text,
    ).not.toContain("@clack");

    const adapterSources = sources.filter(({ name }) =>
      [
        "json5-target-adapter.ts",
        "json-target-adapter.ts",
        "target-adapter.ts",
        "target-adapters.ts",
        "toml-target-adapter.ts",
        "yaml-target-adapter.ts",
      ].includes(name),
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
