import { chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generatedFileMarkerLine } from "../src/generate/marker.js";
import { generatedFilePaths } from "../src/generate/plan.js";
import { runPackage } from "../src/package-command.js";
import {
  createProject,
  defaultPackageJson,
  removeCreatedProjects,
  writeProjectFile,
} from "./support/package-project.js";
import { createTestContext } from "./support/test-context.js";

afterEach(() => {
  removeCreatedProjects();
});

const hashMarker = generatedFileMarkerLine("hash");

function read(root: string, path: string): string {
  return readFileSync(join(root, ...path.split("/")), "utf8");
}

function modifiedAt(root: string, path: string): number {
  return statSync(join(root, ...path.split("/"))).mtimeMs;
}

function stamps(root: string): readonly number[] {
  return generatedFilePaths.map((path) => modifiedAt(root, path));
}

async function run(root: string, args: readonly string[] = []) {
  const harness = createTestContext({ cwd: root });
  const exitCode = await runPackage(args, harness.context);
  return { exitCode, harness };
}

function diagnostic(stderr: readonly string[]): string {
  return stderr.join("");
}

describe("runPackage usage", () => {
  it("rejects any argument without touching the project", async () => {
    const root = createProject();

    const { exitCode, harness } = await run(root, ["--force"]);

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      'Invalid arguments. Run "ai-engine-deploy --help".\n',
    ]);
    expect(readdirSync(root).sort()).toEqual([
      "ai-engine.deploy.json",
      "dist",
      "package-lock.json",
      "package.json",
    ]);
  });
});

describe("runPackage validation order", () => {
  it("reports a missing manifest before reading anything else", async () => {
    const root = createProject({
      omitManifest: true,
      omitPackageJson: true,
      lockfiles: [],
    });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(2);
    expect(diagnostic(harness.stderr)).toBe(
      "MANIFEST_NOT_FOUND: The deployment manifest was not found.\n",
    );
    expect(harness.stdout).toEqual([]);
  });

  it("reports an invalid manifest with its JSON pointer", async () => {
    const root = createProject({
      manifest: { schemaVersion: 1, entry: "dist/mcp-http.js", nope: true },
    });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(2);
    expect(diagnostic(harness.stderr)).toBe(
      [
        "MANIFEST_INVALID: The deployment manifest is invalid.",
        '  "/nope": The key is not part of the manifest schema.',
        "",
      ].join("\n"),
    );
  });

  it("reports an unusable package.json before detecting the lockfile", async () => {
    const root = createProject({
      packageJson: { name: "engine", version: "1.0.0" },
      lockfiles: [],
    });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(diagnostic(harness.stderr)).toContain(
      "PACKAGE_JSON_INVALID: The project package.json is missing required fields.",
    );
    expect(diagnostic(harness.stderr)).toContain('"/scripts/build"');
  });

  it("reports a missing package.json", async () => {
    const root = createProject({ omitPackageJson: true });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(diagnostic(harness.stderr)).toContain("PACKAGE_JSON_INVALID:");
  });

  it("reports a project with no lockfile before checking the entry", async () => {
    const root = createProject({ lockfiles: [], buildEntry: false });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(diagnostic(harness.stderr)).toBe(
      [
        "LOCKFILE_MISSING: No supported lockfile was found.",
        "  package-lock.json",
        "  pnpm-lock.yaml",
        "  yarn.lock",
        "",
      ].join("\n"),
    );
  });

  it("reports a project with more than one lockfile", async () => {
    const root = createProject({
      lockfiles: ["yarn.lock", "pnpm-lock.yaml", "package-lock.json"],
    });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(diagnostic(harness.stderr)).toBe(
      [
        "LOCKFILE_AMBIGUOUS: More than one lockfile was found.",
        "  package-lock.json",
        "  pnpm-lock.yaml",
        "  yarn.lock",
        "",
      ].join("\n"),
    );
  });

  it("reports an entry that has not been built", async () => {
    const root = createProject({ buildEntry: false });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(diagnostic(harness.stderr)).toBe(
      [
        "ENTRY_NOT_BUILT: The HTTP entry module has not been built.",
        "  dist/mcp-http.js",
        "",
      ].join("\n"),
    );
  });

  it("rejects an entry that is a directory rather than a regular file", async () => {
    const root = createProject({ buildEntry: false });
    writeProjectFile(root, "dist/mcp-http.js/placeholder", "");

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(diagnostic(harness.stderr)).toContain("ENTRY_NOT_BUILT:");
  });

  it("writes no generated file when a validation fails", async () => {
    const root = createProject({ buildEntry: false });

    await run(root);

    expect(readdirSync(root).sort()).toEqual([
      "ai-engine.deploy.json",
      "package-lock.json",
      "package.json",
    ]);
  });
});

describe("runPackage generation", () => {
  it("creates the four files, reports them in path order, and writes no stdout", async () => {
    const root = createProject();

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(0);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      "created .dockerignore\n",
      "created Dockerfile\n",
      "created deploy/DEPLOYMENT.md\n",
      "created deploy/healthcheck.mjs\n",
    ]);
    for (const path of generatedFilePaths) {
      expect(read(root, path).endsWith("\n")).toBe(true);
    }
    expect(read(root, "Dockerfile")).toContain("RUN npm ci\n");
    expect(read(root, "Dockerfile").split("\n")[0]).toBe(hashMarker);
  });

  it("creates only the documented files", async () => {
    const root = createProject();

    await run(root);

    expect(readdirSync(root).sort()).toEqual([
      ".dockerignore",
      "Dockerfile",
      "ai-engine.deploy.json",
      "deploy",
      "dist",
      "package-lock.json",
      "package.json",
    ]);
    expect(readdirSync(join(root, "deploy")).sort()).toEqual([
      "DEPLOYMENT.md",
      "healthcheck.mjs",
    ]);
  });

  it("reports an unmodified rerun as unchanged and writes nothing", async () => {
    const root = createProject();
    await run(root);
    const before = stamps(root);

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([
      "unchanged .dockerignore\n",
      "unchanged Dockerfile\n",
      "unchanged deploy/DEPLOYMENT.md\n",
      "unchanged deploy/healthcheck.mjs\n",
    ]);
    expect(stamps(root)).toEqual(before);
  });

  it("updates only the files a manifest change affects", async () => {
    const root = createProject();
    await run(root);
    const before = modifiedAt(root, ".dockerignore");
    writeProjectFile(
      root,
      "ai-engine.deploy.json",
      `${JSON.stringify({
        schemaVersion: 1,
        entry: "dist/mcp-http.js",
        image: { port: 8080 },
      })}\n`,
    );

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([
      "unchanged .dockerignore\n",
      "updated Dockerfile\n",
      "updated deploy/DEPLOYMENT.md\n",
      "updated deploy/healthcheck.mjs\n",
    ]);
    expect(modifiedAt(root, ".dockerignore")).toBe(before);
    expect(read(root, "Dockerfile")).toContain("EXPOSE 8080\n");
  });

  it("overwrites a marked file that an earlier version wrote", async () => {
    const root = createProject({
      files: { Dockerfile: `${hashMarker}\nFROM scratch\n` },
    });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(0);
    expect(harness.stderr).toContain("updated Dockerfile\n");
    expect(read(root, "Dockerfile")).not.toContain("FROM scratch");
  });

  it("emits files a container build can read", async () => {
    const root = createProject();

    await run(root);

    for (const path of generatedFilePaths) {
      const mode = statSync(join(root, ...path.split("/"))).mode & 0o777;
      expect(mode & 0o044).toBe(0o044);
      expect(mode & 0o111).toBe(0);
    }
  });

  it("produces identical bytes for identical inputs in a different directory", async () => {
    const first = createProject();
    const second = createProject();
    await run(first);
    await run(second);

    for (const path of generatedFilePaths) {
      expect(read(second, path)).toBe(read(first, path));
      expect(read(first, path)).not.toContain(first);
    }
  });

  it.each([
    ["package-lock.json", "RUN npm ci\n"],
    ["pnpm-lock.yaml", "RUN pnpm install --frozen-lockfile\n"],
    ["yarn.lock", "RUN yarn install --frozen-lockfile\n"],
  ])(
    "writes the install command detected from %s",
    async (lockfile, command) => {
      const root = createProject({ lockfiles: [lockfile] });

      const { exitCode } = await run(root);

      expect(exitCode).toBe(0);
      expect(read(root, "Dockerfile")).toContain(command);
    },
  );

  it("names the project in the generated documentation", async () => {
    const root = createProject();

    await run(root);

    expect(read(root, "deploy/DEPLOYMENT.md")).toContain(
      defaultPackageJson.name,
    );
  });
});

describe("runPackage conflicts", () => {
  it("leaves an unmarked file untouched, generates the rest, and exits 1", async () => {
    const original = 'FROM node:22-slim\nCMD ["node", "server.js"]\n';
    const root = createProject({ files: { Dockerfile: original } });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.slice(0, 4)).toEqual([
      "created .dockerignore\n",
      "conflict Dockerfile\n",
      "created deploy/DEPLOYMENT.md\n",
      "created deploy/healthcheck.mjs\n",
    ]);
    expect(diagnostic(harness.stderr)).toContain(
      "GENERATED_FILE_CONFLICT: An existing file is not managed by the toolkit.",
    );
    expect(diagnostic(harness.stderr)).toContain(hashMarker);
    expect(read(root, "Dockerfile")).toBe(original);
    expect(read(root, ".dockerignore").split("\n")[0]).toBe(hashMarker);
  });

  it("reports every conflicting file once", async () => {
    const root = createProject({
      files: {
        ".dockerignore": "node_modules\n",
        "deploy/DEPLOYMENT.md": "# mine\n",
      },
    });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(harness.stderr.slice(0, 4)).toEqual([
      "conflict .dockerignore\n",
      "created Dockerfile\n",
      "conflict deploy/DEPLOYMENT.md\n",
      "created deploy/healthcheck.mjs\n",
    ]);
    const rendered = diagnostic(harness.stderr);
    expect(rendered.match(/GENERATED_FILE_CONFLICT/gu)).toHaveLength(1);
    expect(rendered).toContain(".dockerignore");
    expect(rendered).toContain("deploy/DEPLOYMENT.md");
  });

  it("treats a file whose marker is not on the first line as a conflict", async () => {
    const root = createProject({
      files: { Dockerfile: `FROM node:22-slim\n${hashMarker}\n` },
    });

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain("conflict Dockerfile\n");
  });

  it("treats a directory in place of a generated file as a conflict", async () => {
    const root = createProject();
    writeProjectFile(root, "Dockerfile/keep", "");

    const { exitCode, harness } = await run(root);

    expect(exitCode).toBe(1);
    expect(harness.stderr).toContain("conflict Dockerfile\n");
    expect(readdirSync(join(root, "Dockerfile"))).toEqual(["keep"]);
  });
});

describe("runPackage failures", () => {
  const privileged = process.getuid?.() === 0;

  it.skipIf(privileged)(
    "reports a write failure with the file path and exits 1",
    async () => {
      const root = createProject();
      // A read-only target directory makes the atomic temporary write fail.
      writeProjectFile(root, "deploy/keep", "");
      const deployDirectory = join(root, "deploy");
      chmodSync(deployDirectory, 0o500);

      const { exitCode, harness } = await run(root);

      chmodSync(deployDirectory, 0o700);
      expect(exitCode).toBe(1);
      expect(harness.stdout).toEqual([]);
      expect(harness.stderr.slice(0, 2)).toEqual([
        "created .dockerignore\n",
        "created Dockerfile\n",
      ]);
      expect(diagnostic(harness.stderr)).toContain(
        "WRITE_FAILED: A deployment file could not be written.",
      );
      expect(diagnostic(harness.stderr)).toContain("deploy/DEPLOYMENT.md");
    },
  );
});
