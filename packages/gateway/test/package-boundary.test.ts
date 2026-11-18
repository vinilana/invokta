import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sourceDirectory = join(packageDirectory, "src");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function sources(): { readonly name: string; readonly text: string }[] {
  return readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      text: readFileSync(join(sourceDirectory, name), "utf8"),
    }));
}

const SPECIFIER =
  /\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']|\brequire\s*\(\s*["']([^"'\n]+)["']/gu;

describe("@invokta/gateway package boundary", () => {
  it("is a publishable ESM package that depends only on the core", () => {
    const manifest = readJson(join(packageDirectory, "package.json"));
    const core = readJson(join(repositoryRoot, "packages/core/package.json"));

    expect(manifest).toMatchObject({
      name: "@invokta/gateway",
      version: core.version,
      type: "module",
      sideEffects: false,
      files: ["dist"],
      homepage: "https://docs.invokta.dev/reference/gateway/",
      publishConfig: { access: "public" },
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
    });
    expect(manifest).not.toHaveProperty("private");
    expect(manifest.dependencies).toEqual({ "@invokta/core": core.version });
    expect(manifest).not.toHaveProperty("peerDependencies");
    expect(manifest).not.toHaveProperty("optionalDependencies");
    expect(manifest).not.toHaveProperty("bin");
  });

  it("imports only relative modules and the core", () => {
    const list = sources();
    expect(list.length).toBeGreaterThan(5);
    for (const source of list) {
      const specifiers = Array.from(
        source.text.matchAll(SPECIFIER),
        (match) => match[1] ?? match[2] ?? "",
      );
      for (const specifier of specifiers) {
        if (specifier.startsWith("./")) continue;
        expect(specifier, source.name).toBe("@invokta/core");
      }
    }
  });

  it("detects prefixed, bare, dynamic, re-exported, and required built-ins", () => {
    const planted = [
      'import { randomUUID } from "node:crypto";',
      'export { readFile } from "fs";',
      'const os = await import("node:os");',
      'const net = require("net");',
    ].join("\n");
    const found = Array.from(
      planted.matchAll(SPECIFIER),
      (match) => match[1] ?? match[2] ?? "",
    ).filter((name) => isBuiltin(name));

    expect(found).toEqual(["node:crypto", "fs", "node:os", "net"]);
  });

  it("uses only ECMAScript and Web platform globals", () => {
    for (const source of sources()) {
      const specifiers = Array.from(
        source.text.matchAll(SPECIFIER),
        (match) => match[1] ?? match[2] ?? "",
      );
      expect(
        specifiers.filter((name) => isBuiltin(name)),
        source.name,
      ).toEqual([]);
      // Comments are skipped so prose such as "this process." is not a use.
      const code = source.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
      expect(code, source.name).not.toMatch(
        /\bprocess\.|\bBuffer\b|\b__dirname\b|\brequire\(/u,
      );
    }
  });

  it("keeps the adapters and the MCP SDK out of its dependencies", () => {
    const manifest = readJson(join(packageDirectory, "package.json"));
    const names = Object.keys(
      (manifest.dependencies ?? {}) as Record<string, string>,
    );
    for (const forbidden of [
      "@invokta/mcp",
      "@invokta/http",
      "@invokta/auth-jwt",
      "@modelcontextprotocol/sdk",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("participates in the root TypeScript project and release manifest", () => {
    const rootConfig = readJson(join(repositoryRoot, "tsconfig.json"));
    const references = rootConfig.references as { readonly path: string }[];
    const releasePackages = JSON.parse(
      readFileSync(
        join(repositoryRoot, "scripts/release/release-packages.json"),
        "utf8",
      ),
    ) as { readonly directory: string; readonly name: string }[];
    const names = releasePackages.map((entry) => entry.name);

    expect(references).toContainEqual({ path: "./packages/gateway" });
    expect(releasePackages).toContainEqual(
      expect.objectContaining({
        name: "@invokta/gateway",
        directory: "gateway",
      }),
    );
    expect(names.indexOf("@invokta/gateway")).toBeGreaterThan(
      names.indexOf("@invokta/core"),
    );
  });
});
