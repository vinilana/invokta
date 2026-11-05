import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const hostSimulation = pathToFileURL(
  fileURLToPath(new URL("./fixtures/web-runtime-host.mjs", import.meta.url)),
).href;
const handlerFixture = fileURLToPath(
  new URL("./fixtures/web-runtime-handler.mjs", import.meta.url),
);

describe("@invokta/http on a Web-standard host", () => {
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-b",
        "packages/core",
        "packages/http",
        "--pretty",
        "false",
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
  });

  it("serves the routes without Node.js built-ins, host introspection, or eval", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--disallow-code-generation-from-strings",
        "--import",
        hostSimulation,
        handlerFixture,
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      getBuiltinModule: "undefined",
      listed: {
        status: 200,
        body: { capabilities: [{ id: "support.inspect" }] },
      },
      openapi: { status: 200, version: "3.1.0" },
      invoked: {
        status: 200,
        body: {
          value: "portable",
          principalId: "user:alice",
          source: "http",
        },
      },
      unauthorized: { status: 401, challenge: "Bearer" },
    });
  });

  it("refuses the Node.js entry point under the same host simulation", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        hostSimulation,
        "--input-type=module",
        "--eval",
        'await import("./packages/http/dist/node.js");',
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 20_000 },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Node\.js built-in node:[a-z_]+ requested/u);
  });
});
