import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const webModules = ["index.ts", "handler.ts", "openapi.ts"] as const;

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
}

describe("Web-standard module boundary", () => {
  it.each(webModules)("%s imports no Node-only module or global", (name) => {
    const text = source(name);

    expect(text).not.toMatch(/from\s+["']node:/u);
    expect(text).not.toMatch(/import\(\s*["']node:/u);
    expect(text).not.toMatch(/\brequire\(/u);
    expect(text).not.toMatch(/\bBuffer\b/u);
    expect(text).not.toMatch(/\bprocess\./u);
    expect(text).not.toMatch(/from\s+["']\.\/node\.js["']/u);
  });

  it("keeps the Node server entry point on a separate subpath", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly exports: Readonly<Record<string, unknown>> };

    expect(Object.keys(manifest.exports)).toEqual([".", "./node"]);
    expect(source("node.ts")).toMatch(/from\s+["']node:http["']/u);
  });
});
