import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEngine,
  defineCapability,
  type EngineSchema,
} from "@invokta/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ServeHandles } from "../src/serve.js";
import { startServe } from "../src/serve.js";
import { startOnAvailablePort } from "./available-port.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

const fixtureSchema = {
  "~standard": {
    version: 1,
    vendor: "invokta-devtools-test",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => ({ type: "object" }),
      output: () => ({ type: "object" }),
    },
  },
} as unknown as EngineSchema<
  Readonly<Record<string, unknown>>,
  Readonly<Record<string, unknown>>
>;

describe("shipped interface bundle", () => {
  let handles: ServeHandles;
  let base = "";

  beforeAll(async () => {
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-b",
        "packages/devtools",
        "--pretty",
        "false",
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );

    const engine = createEngine({
      name: "static-test-engine",
      version: "0.1.0",
      capabilities: {
        "fixture.echo": defineCapability({
          description: "Echoes the fixture input.",
          input: fixtureSchema,
          output: fixtureSchema,
          access: "public",
          async run({ input }) {
            return { echoed: input };
          },
        }),
      },
    });

    const result = await startOnAvailablePort((port) =>
      startServe({
        engine,
        cwd: repositoryRoot,
        composedCapabilitiesExport: false,
        port,
        uiRoot: join(repositoryRoot, "packages/devtools/dist/ui"),
      }),
    );
    if (result.kind !== "started") throw new Error("serve was refused");
    handles = result.handles;
    base = `http://127.0.0.1:${String(handles.devtoolsAddress.port)}`;
  });

  afterAll(async () => {
    await handles?.close();
  });

  it("builds every interface module into dist/ui", () => {
    const expectedModules = readdirSync(
      join(repositoryRoot, "packages/devtools/src/ui"),
    )
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.replace(/\.ts$/u, ".js"));
    expect(expectedModules.length).toBeGreaterThan(0);

    for (const name of expectedModules) {
      expect(
        existsSync(join(repositoryRoot, "packages/devtools/dist/ui", name)),
        name,
      ).toBe(true);
    }
  });

  it("serves the application shell that loads the bundle", async () => {
    const response = await fetch(`${base}/`);

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("<title>Invokta devtools</title>");
    expect(page).toContain('<html lang="en" data-theme="dark">');
    expect(page).toContain('localStorage.getItem("starlight-theme")');
    expect(page.indexOf("starlight-theme")).toBeLessThan(
      page.indexOf('src="/assets/app.js"'),
    );
    expect(page).toContain(
      '<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">',
    );
    expect(page).toContain('src="/assets/app.js"');
  });

  it("serves the compiled bundle modules under /assets/", async () => {
    const app = await fetch(`${base}/assets/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/javascript");
    expect(await app.text()).toContain("boot");

    const styles = await fetch(`${base}/assets/styles.js`);
    expect(styles.status).toBe(200);

    const favicon = await fetch(`${base}/assets/favicon.svg`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/svg+xml");
    expect(favicon.headers.get("cache-control")).toBe("no-store");
    expect(await favicon.text()).toMatch(
      /^<svg[^>]+viewBox="0 0 32 32"[\s\S]+stroke="#3D50F5"[\s\S]+<\/svg>$/u,
    );
  });
});
