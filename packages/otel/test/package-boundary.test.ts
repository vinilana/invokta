import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function dependencyNames(manifest: Record<string, unknown>): string[] {
  return ["dependencies", "peerDependencies", "optionalDependencies"].flatMap(
    (field) => Object.keys((manifest[field] ?? {}) as Record<string, string>),
  );
}

describe("@invokta/otel package boundary", () => {
  it("depends only on the core and the OpenTelemetry API peer", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);

    expect(manifest).toMatchObject({
      name: "@invokta/otel",
      type: "module",
      sideEffects: false,
      files: ["dist"],
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
    });
    expect(manifest.dependencies).toEqual({ "@invokta/core": "0.9.1" });
    expect(manifest.peerDependencies).toEqual({
      "@opentelemetry/api": "^1.9.0",
    });
    expect(manifest).not.toHaveProperty("optionalDependencies");
    expect(manifest).not.toHaveProperty("bin");
  });

  it("imports only the OpenTelemetry API and core types at runtime", () => {
    const sourceDirectory = `${packageDirectory}/src`;
    const sources = readdirSync(sourceDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => ({
        name: entry.name,
        text: readFileSync(`${sourceDirectory}/${entry.name}`, "utf8"),
      }));

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const specifiers = [
        ...source.text.matchAll(
          /^import\s+(type\s+)?[^"']*["']([^"']+)["']/gmu,
        ),
      ].map((match) => ({ typeOnly: match[1] !== undefined, from: match[2] }));
      for (const specifier of specifiers) {
        if (specifier.from?.startsWith("./")) continue;
        if (specifier.from === "@invokta/core") {
          expect(specifier.typeOnly, source.name).toBe(true);
          continue;
        }
        expect(specifier.from, source.name).toBe("@opentelemetry/api");
      }
    }
  });

  it("loads no Node.js built-in from its source or the OpenTelemetry API", () => {
    const specifier =
      /\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']|\brequire\s*\(\s*["']([^"'\n]+)["']/gu;
    const builtins = (path: string): string[] =>
      Array.from(
        readFileSync(path, "utf8").matchAll(specifier),
        (match) => match[1] ?? match[2] ?? "",
      ).filter((name) => isBuiltin(name));
    const sourceDirectory = `${packageDirectory}/src`;
    const sources = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(sourceDirectory, name));
    const apiDirectory = `${repositoryRoot}/node_modules/@opentelemetry/api/build/esm`;
    const apiModules = readdirSync(apiDirectory, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(entry.parentPath, entry.name));

    expect(apiModules.length).toBeGreaterThan(10);
    for (const path of [...sources, ...apiModules]) {
      expect(builtins(path), path).toEqual([]);
    }
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/\bprocess\.|\bBuffer\b/u);
    }
  });

  it("keeps OpenTelemetry out of every other public package", () => {
    const packagesDirectory = `${repositoryRoot}/packages`;
    for (const entry of readdirSync(packagesDirectory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name === "otel") continue;
      const manifest = readJson(
        `${packagesDirectory}/${entry.name}/package.json`,
      );
      expect(
        dependencyNames(manifest).filter((name) =>
          name.startsWith("@opentelemetry/"),
        ),
        entry.name,
      ).toEqual([]);
    }
  });

  it("participates in the root TypeScript project and release manifest", () => {
    const rootConfig = readJson(`${repositoryRoot}/tsconfig.json`);
    const references = rootConfig.references as { readonly path: string }[];
    const releasePackages = JSON.parse(
      readFileSync(
        `${repositoryRoot}/scripts/release/release-packages.json`,
        "utf8",
      ),
    ) as { readonly directory: string; readonly name: string }[];
    const names = releasePackages.map((entry) => entry.name);

    expect(references).toContainEqual({ path: "./packages/otel" });
    expect(names).toContain("@invokta/otel");
    expect(names.indexOf("@invokta/otel")).toBeGreaterThan(
      names.indexOf("@invokta/core"),
    );
  });
});
