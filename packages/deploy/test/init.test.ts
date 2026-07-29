import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";
import { parseDeployManifest } from "../src/manifest.js";
import {
  createScaffoldFiles,
  environmentModuleTemplate,
  httpAuthModuleTemplate,
  renderEnvironmentExample,
  renderHttpRootModule,
  starterDeployManifest,
} from "../src/scaffold/index.js";
import { createTestContext } from "./support/test-context.js";

const scaffoldPaths = [
  ".env.example",
  "invokta.deploy.json",
  "src/env.ts",
  "src/http-auth.ts",
  "src/mcp-http.ts",
] as const;

const projects: string[] = [];

function createProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-init-"));
  projects.push(directory);
  return directory;
}

function writeManifest(directory: string, document: unknown): void {
  writeFileSync(
    join(directory, "invokta.deploy.json"),
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
}

function read(directory: string, relativePath: string): string {
  return readFileSync(join(directory, relativePath), "utf8");
}

afterEach(() => {
  for (const directory of projects.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runInit", () => {
  it("creates every scaffold file of an empty project in lexicographic order", async () => {
    const cwd = createProject();
    const harness = createTestContext({ cwd });

    const exitCode = await runInit([], harness.context);

    expect(exitCode).toBe(0);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "created .env.example\n",
      "created invokta.deploy.json\n",
      "created src/env.ts\n",
      "created src/http-auth.ts\n",
      "created src/mcp-http.ts\n",
    ]);
    for (const path of scaffoldPaths) {
      expect(existsSync(join(cwd, path))).toBe(true);
    }
  });

  it("writes the templates the scaffold modules define", async () => {
    const cwd = createProject();

    await runInit([], createTestContext({ cwd }).context);

    expect(read(cwd, "src/env.ts")).toBe(environmentModuleTemplate);
    expect(read(cwd, "src/http-auth.ts")).toBe(httpAuthModuleTemplate);
    expect(read(cwd, "src/mcp-http.ts")).toBe(
      renderHttpRootModule(starterDeployManifest),
    );
    expect(read(cwd, ".env.example")).toBe(
      renderEnvironmentExample(starterDeployManifest.env),
    );
  });

  it("writes a starter manifest that the manifest gate accepts", async () => {
    const cwd = createProject();

    await runInit([], createTestContext({ cwd }).context);
    const result = parseDeployManifest(read(cwd, "invokta.deploy.json"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entry).toBe("dist/mcp-http.js");
    expect(result.manifest.env).toEqual({ required: [], optional: [] });
    expect(result.manifest.schemaVersion).toBe(1);
  });

  it("writes UTF-8 text with LF endings and one trailing newline", async () => {
    const cwd = createProject();

    await runInit([], createTestContext({ cwd }).context);

    for (const path of scaffoldPaths) {
      const contents = read(cwd, path);
      expect(contents).not.toContain("\r");
      expect(contents).not.toContain("\u0000");
      expect(contents.endsWith("\n")).toBe(true);
      expect(contents.endsWith("\n\n")).toBe(false);
    }
  });

  it("skips every existing target on a rerun and writes nothing", async () => {
    const cwd = createProject();
    await runInit([], createTestContext({ cwd }).context);
    const before = scaffoldPaths.map((path) => ({
      contents: read(cwd, path),
      modifiedAt: statSync(join(cwd, path)).mtimeMs,
    }));
    const harness = createTestContext({ cwd });

    const exitCode = await runInit([], harness.context);

    expect(exitCode).toBe(0);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "skipped .env.example\n",
      "skipped invokta.deploy.json\n",
      "skipped src/env.ts\n",
      "skipped src/http-auth.ts\n",
      "skipped src/mcp-http.ts\n",
    ]);
    for (const [index, path] of scaffoldPaths.entries()) {
      expect(read(cwd, path)).toBe(before[index]?.contents);
      expect(statSync(join(cwd, path)).mtimeMs).toBe(before[index]?.modifiedAt);
    }
  });

  it("keeps an existing file untouched and still creates the absent ones", async () => {
    const cwd = createProject();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/mcp-http.ts"), "// mine\n", "utf8");
    const harness = createTestContext({ cwd });

    const exitCode = await runInit([], harness.context);

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([
      "created .env.example\n",
      "created invokta.deploy.json\n",
      "created src/env.ts\n",
      "created src/http-auth.ts\n",
      "skipped src/mcp-http.ts\n",
    ]);
    expect(read(cwd, "src/mcp-http.ts")).toBe("// mine\n");
  });

  it("derives the example file and the required-name check from an existing manifest", async () => {
    const cwd = createProject();
    writeManifest(cwd, {
      schemaVersion: 1,
      entry: "dist/mcp-http.js",
      env: {
        required: ["SUPPORT_API_TOKEN", "SUPPORT_API_URL"],
        optional: ["INVOKTA_HTTP_ALLOWED_ORIGINS"],
      },
    });
    const harness = createTestContext({ cwd });

    const exitCode = await runInit([], harness.context);

    expect(exitCode).toBe(0);
    expect(harness.stderr[1]).toBe("skipped invokta.deploy.json\n");
    expect(read(cwd, ".env.example")).toContain(
      "SUPPORT_API_TOKEN=\nSUPPORT_API_URL=\n",
    );
    expect(read(cwd, ".env.example")).toContain(
      "INVOKTA_HTTP_ALLOWED_ORIGINS=\n",
    );
    expect(read(cwd, ".env.example").indexOf("SUPPORT_API_TOKEN")).toBeLessThan(
      read(cwd, ".env.example").indexOf("ALLOWED_ORIGINS"),
    );
    expect(read(cwd, "src/mcp-http.ts")).toContain(
      '  "SUPPORT_API_TOKEN",\n  "SUPPORT_API_URL",\n',
    );
  });

  it("declares no required names when the manifest declares none", async () => {
    const cwd = createProject();

    await runInit([], createTestContext({ cwd }).context);

    expect(read(cwd, "src/mcp-http.ts")).toContain("[] as const");
  });

  it("fails with the stable manifest error before writing anything", async () => {
    const cwd = createProject();
    writeManifest(cwd, { schemaVersion: 1, entry: "../escape.js" });
    const harness = createTestContext({ cwd });

    const exitCode = await runInit([], harness.context);

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join("")).toBe(
      'MANIFEST_INVALID: The deployment manifest is invalid.\n  "/entry": The entry path must stay inside the project.\n',
    );
    expect(existsSync(join(cwd, ".env.example"))).toBe(false);
    expect(existsSync(join(cwd, "src"))).toBe(false);
  });

  it("rejects unknown arguments with a sanitized usage line", async () => {
    const cwd = createProject();
    const harness = createTestContext({ cwd });

    const exitCode = await runInit(["--force"], harness.context);

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      'Invalid arguments. Run "invokta-deploy --help".\n',
    ]);
    expect(existsSync(join(cwd, ".env.example"))).toBe(false);
    expect(existsSync(join(cwd, "src"))).toBe(false);
  });

  it("never echoes a rejected argument", async () => {
    const cwd = createProject();
    const harness = createTestContext({ cwd });

    await runInit(["--token=fixture-secret-payload-marker"], harness.context);

    expect(harness.stderr.join("")).not.toContain(
      "fixture-secret-payload-marker",
    );
  });
});

describe("createScaffoldFiles", () => {
  it("lists the five targets in lexicographic path order", () => {
    const files = createScaffoldFiles(starterDeployManifest);

    expect(files.map((file) => file.path)).toEqual([...scaffoldPaths]);
  });
});
