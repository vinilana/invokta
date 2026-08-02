import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function sources() {
  const sourceDirectory = `${packageDirectory}/src`;
  return readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      text: readFileSync(`${sourceDirectory}/${name}`, "utf8"),
    }));
}

describe("@invokta/console package boundary", () => {
  it("publishes the console executable and its page", () => {
    const manifest = readJson(`${packageDirectory}/package.json`);

    expect(manifest).toMatchObject({
      name: "@invokta/console",
      version: "0.3.0",
      type: "module",
      engines: { node: ">=22.20.0" },
      files: ["dist", "web"],
      exports: {},
      bin: { "invokta-console": "./dist/cli.js" },
      dependencies: { "@invokta/client-config": "0.3.0" },
    });
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("types");
  });

  it("depends on the installer core and on no framework or tooling package", () => {
    const dependencies = readJson(`${packageDirectory}/package.json`)
      .dependencies as Record<string, string>;

    expect(Object.keys(dependencies)).toEqual(["@invokta/client-config"]);
  });

  it("participates in the root TypeScript project after the core", () => {
    const references = readJson(`${repositoryRoot}/tsconfig.json`)
      .references as { readonly path: string }[];

    expect(references).toContainEqual({ path: "./packages/console" });
    expect(
      references.findIndex(({ path }) => path === "./packages/client-config"),
    ).toBeLessThan(
      references.findIndex(({ path }) => path === "./packages/console"),
    );
    expect(readJson(`${packageDirectory}/tsconfig.json`).references).toEqual([
      { path: "../client-config" },
    ]);
  });

  it("keeps framework packages and outbound clients out of the source", () => {
    for (const source of sources()) {
      expect(source.text, source.name).not.toMatch(
        /["']@invokta\/(?:core|cli|mcp|tooling|deploy|installer)["']/u,
      );
      expect(source.text, source.name).not.toMatch(
        /["']node:(?:https|net|tls|dns|dgram|http2)["']/u,
      );
      expect(source.text, source.name).not.toMatch(
        /globalThis\.fetch|\bfetch\(|new WebSocket/u,
      );
    }
  });

  it("confines the listening socket and the process launch to one module each", () => {
    const listeners = sources()
      .filter(({ text }) => text.includes('from "node:http"'))
      .map(({ name }) => name);
    const launchers = sources()
      .filter(({ text }) => text.includes('from "node:child_process"'))
      .map(({ name }) => name);

    expect(listeners).toEqual(["console-server.ts"]);
    expect(launchers).toEqual(["browser.ts"]);
  });

  it("binds loopback and nothing else", () => {
    const startConsole = readFileSync(
      `${packageDirectory}/src/start-console.ts`,
      "utf8",
    );

    expect(startConsole).toContain('server.listen(options.port, "127.0.0.1"');
    expect(startConsole).not.toMatch(/0\.0\.0\.0|::(?!1)/u);
  });

  it("reaches the core diagnostics through the dependency-free subpath on the usage path", () => {
    const cli = readFileSync(`${packageDirectory}/src/cli.ts`, "utf8");
    const runner = readFileSync(
      `${packageDirectory}/src/run-console-cli.ts`,
      "utf8",
    );

    expect(cli).not.toMatch(/@invokta\/client-config"/u);
    expect(runner).toContain('from "@invokta/client-config/errors"');
    expect(runner).not.toMatch(/from "@invokta\/client-config"/u);
  });
});
