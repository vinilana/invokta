import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("@ai-engine/installer package boundary", () => {
  it("publishes only the standalone executable on the repository runtime floor", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);

    expect(manifest).toMatchObject({
      name: "@ai-engine/installer",
      version: "0.1.0",
      type: "module",
      engines: { node: ">=22.20.0" },
      files: ["dist", "registry"],
      exports: {},
      bin: { "ai-engine-installer": "./dist/cli.js" },
      dependencies: { "@clack/prompts": "1.7.0" },
    });
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("types");
  });

  it("has no dependency on an AI Engine framework or tooling package", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);
    const dependencies = manifest.dependencies as Record<string, string>;

    expect(
      Object.keys(dependencies).filter((name) =>
        name.startsWith("@ai-engine/"),
      ),
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
        /["']@ai-engine\/(?:core|cli|mcp|tooling)["']/u,
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
  });
});
