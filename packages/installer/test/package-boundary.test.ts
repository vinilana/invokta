import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("@invokta/installer package boundary", () => {
  it("publishes only the standalone executable on the repository runtime floor", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);

    expect(manifest).toMatchObject({
      name: "@invokta/installer",
      version: "0.3.0",
      type: "module",
      engines: { node: ">=22.20.0" },
      files: ["dist"],
      exports: {},
      bin: { "invokta-installer": "./dist/cli.js" },
      dependencies: {
        "@clack/prompts": "1.7.0",
        "@invokta/client-config": "0.3.0",
      },
    });
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("types");
  });

  it("depends on the installer core and on no framework or tooling package", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);
    const dependencies = manifest.dependencies as Record<string, string>;

    expect(
      Object.keys(dependencies).filter((name) => name.startsWith("@invokta/")),
    ).toEqual(["@invokta/client-config"]);
  });

  it("no longer carries the configuration engine or its registry", () => {
    const sources = readdirSync(`${packageDirectory}/src`);

    expect(sources.sort()).toEqual([
      "clack-interactive-prompter.ts",
      "cli.ts",
      "engine-removal-session.ts",
      "install-session.ts",
      "interactive-prompter.ts",
      "interactive-session.ts",
      "management-session.ts",
      "read-only-inventory.ts",
      "run-installer-cli.ts",
    ]);
    expect(readdirSync(packageDirectory)).not.toContain("registry");
  });

  it("participates in the root TypeScript project after the core", () => {
    const rootConfig = readJson(`${repositoryRoot}/tsconfig.json`);
    const references = rootConfig.references as { readonly path: string }[];
    const config = readJson(`${packageDirectory}/tsconfig.json`);

    expect(references).toContainEqual({ path: "./packages/installer" });
    expect(
      references.findIndex(({ path }) => path === "./packages/client-config"),
    ).toBeLessThan(
      references.findIndex(({ path }) => path === "./packages/installer"),
    );
    expect(config.references).toEqual([{ path: "../client-config" }]);
  });

  it("keeps framework, process execution, and network imports outside the package", () => {
    const sourceDirectory = `${packageDirectory}/src`;
    const sources = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({
        name,
        text: readFileSync(`${sourceDirectory}/${name}`, "utf8"),
      }));

    for (const source of sources) {
      expect(source.text, source.name).not.toMatch(
        /["']@invokta\/(?:core|cli|mcp|tooling|deploy)["']/u,
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

  it("hands the platform contract to every engine manifest loader", () => {
    const session = readFileSync(
      `${packageDirectory}/src/interactive-session.ts`,
      "utf8",
    );
    const calls = [
      ...session.matchAll(
        /loadEngine(?:Install|Removal)Manifest\(\{([^}]*)\}/gu,
      ),
    ];

    // Windows has no user id, so a loader that falls back to the POSIX default
    // rejects every project before it reads a byte.
    expect(calls).toHaveLength(2);
    for (const [, argumentList] of calls) {
      expect(argumentList).toContain("contract");
    }
  });

  it("reaches the core through its dependency-free subpath on the cold-start path", () => {
    const coldStart = ["cli.ts", "run-installer-cli.ts"];

    for (const name of coldStart) {
      const text = readFileSync(`${packageDirectory}/src/${name}`, "utf8");
      expect(text, name).not.toMatch(/from "@invokta\/client-config"/u);
    }
    expect(
      readFileSync(`${packageDirectory}/src/run-installer-cli.ts`, "utf8"),
    ).toContain('from "@invokta/client-config/errors"');
  });
});
