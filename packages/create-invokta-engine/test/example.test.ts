import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { c as createTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";

import {
  CreatorError,
  renderCreatorDiagnostic,
  sanitizeDiagnosticDetail,
} from "../src/errors.js";
import {
  createExampleProject,
  type ExampleFetch,
  type ExampleRepoInfo,
  parseExampleReference,
  resolveExampleReference,
} from "../src/example.js";

const temporaryDirectories: string[] = [];

function createWorkingDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-example-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function buildRepositoryArchive(options: {
  readonly rootName: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly symlinks?: Readonly<Record<string, string>>;
}): Promise<Buffer> {
  const root = createWorkingDirectory();
  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    const absolute = join(root, options.rootName, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  for (const [relativePath, target] of Object.entries(options.symlinks ?? {})) {
    const absolute = join(root, options.rootName, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    symlinkSync(target, absolute);
  }
  const archivePath = join(root, "repository.tar.gz");
  await createTar(
    {
      gzip: true,
      file: archivePath,
      cwd: root,
    },
    [options.rootName],
  );
  return readFileSync(archivePath);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFetch(options: {
  readonly defaultBranch?: string;
  readonly packagePaths?: ReadonlySet<string>;
  readonly archive?: Buffer;
}): ExampleFetch {
  const packagePaths = options.packagePaths ?? new Set(["package.json"]);
  return async (input, init) => {
    const url = new URL(input);
    if (
      url.hostname === "api.github.com" &&
      url.pathname.startsWith("/repos/") &&
      !url.pathname.includes("/contents/")
    ) {
      expect(init?.redirect).toBe("error");
      return jsonResponse({ default_branch: options.defaultBranch ?? "main" });
    }
    if (
      url.hostname === "api.github.com" &&
      url.pathname.includes("/contents/")
    ) {
      expect(init?.redirect).toBe("error");
      const pathWithRef = url.pathname.split("/contents/")[1] ?? "";
      const decoded = decodeURIComponent(pathWithRef);
      const ok =
        (init?.method ?? "GET") === "HEAD" && packagePaths.has(decoded);
      return new Response(null, { status: ok ? 200 : 404 });
    }
    if (url.hostname === "codeload.github.com") {
      if (options.archive === undefined) {
        return new Response(null, { status: 404 });
      }
      expect(init?.redirect).toBe("error");
      const body = Readable.toWeb(Readable.from(options.archive));
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/gzip" },
      });
    }
    return new Response(null, { status: 404 });
  };
}

async function resolveTreeExample(
  url: string,
  archive: Buffer,
  packagePath: string,
): Promise<{
  readonly info: ExampleRepoInfo;
  readonly fetchImpl: ExampleFetch;
}> {
  const fetchImpl = createFetch({
    packagePaths: new Set([packagePath]),
    archive,
  });
  const info = await resolveExampleReference(url, undefined, fetchImpl);
  return { info, fetchImpl };
}

describe("parseExampleReference", () => {
  it("resolves official short names under examples/ on main", () => {
    expect(parseExampleReference("auth-clerk-engine")).toEqual({
      owner: "vinilana",
      repository: "invokta",
      branch: "main",
      filePath: "examples/auth-clerk-engine",
      label: "auth-clerk-engine",
    });
  });

  it("resolves repository and tree GitHub URLs", () => {
    expect(
      parseExampleReference("https://github.com/acme/engine-template"),
    ).toEqual({
      owner: "acme",
      repository: "engine-template",
      branch: "",
      filePath: "",
      label: "acme/engine-template",
    });
    expect(
      parseExampleReference(
        "https://github.com/acme/repo/tree/main/templates/engine",
      ),
    ).toEqual({
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "templates/engine",
      label: "acme/repo/templates/engine",
    });
  });

  it("lets --example-path override a tree URL path", () => {
    expect(
      parseExampleReference(
        "https://github.com/acme/repo/tree/main/ignored",
        "templates/engine",
      ),
    ).toMatchObject({
      branch: "main",
      filePath: "templates/engine",
      label: "acme/repo/templates/engine",
    });
  });

  it("rejects non-HTTPS, non-GitHub, and percent-encoded traversal references", () => {
    for (const example of [
      "http://github.com/acme/repo",
      "https://gitlab.com/acme/repo",
      "git@github.com:acme/repo.git",
      "https://user:pass@github.com/acme/repo",
      "https://github.com/a%2f..%2fb/repo",
      "https://github.com/acme/re%2fpo",
      "../escape",
      "",
    ]) {
      expect(() => parseExampleReference(example)).toThrowError(CreatorError);
      try {
        parseExampleReference(example);
      } catch (error) {
        expect(error).toMatchObject({ code: "EXAMPLE_INVALID" });
      }
    }
  });
});

describe("resolveExampleReference", () => {
  it("fills the default branch and requires package.json", async () => {
    const fetchImpl = createFetch({
      defaultBranch: "develop",
      packagePaths: new Set(["templates/engine/package.json"]),
    });
    await expect(
      resolveExampleReference(
        "https://github.com/acme/engine-template",
        "templates/engine",
        fetchImpl,
      ),
    ).resolves.toEqual({
      owner: "acme",
      repository: "engine-template",
      branch: "develop",
      filePath: "templates/engine",
      label: "acme/engine-template/templates/engine",
    });
  });

  it("fails when package.json is missing", async () => {
    const fetchImpl = createFetch({ packagePaths: new Set() });
    await expect(
      resolveExampleReference("auth-clerk-engine", undefined, fetchImpl),
    ).rejects.toMatchObject({
      code: "EXAMPLE_UNAVAILABLE",
      details: ["package.json"],
    });
  });

  it("treats API redirects as unavailable", async () => {
    const fetchImpl: ExampleFetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/repos/acme/repo" },
      });
    };
    await expect(
      resolveExampleReference(
        "https://github.com/acme/repo",
        undefined,
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "EXAMPLE_UNAVAILABLE" });
  });
});

describe("diagnostic sanitization", () => {
  it("escapes terminal-active characters in CreatorError details", () => {
    const evil = "evil\u001b]0;pwned\u0007.txt";
    expect(sanitizeDiagnosticDetail(evil)).not.toContain("\u001b");
    expect(sanitizeDiagnosticDetail(evil)).not.toContain("\u0007");
    const rendered = renderCreatorDiagnostic(
      new CreatorError("EXAMPLE_FAILED", [evil]),
    );
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("\\u001b");
  });
});

describe("createExampleProject", () => {
  it("downloads a subtree, rewrites package name, and copies files", async () => {
    const cwd = createWorkingDirectory();
    const archive = await buildRepositoryArchive({
      rootName: "repo-main",
      files: {
        "templates/engine/package.json":
          '{\n  "name": "@acme/template",\n  "private": true\n}\n',
        "templates/engine/src/engine.ts": "export const ready = true;\n",
        "README.md": "repo root\n",
      },
    });
    const { info, fetchImpl } = await resolveTreeExample(
      "https://github.com/acme/repo/tree/main/templates/engine",
      archive,
      "templates/engine/package.json",
    );

    const project = await createExampleProject({
      cwd,
      target: "my-engine",
      example: info,
      fetch: fetchImpl,
    });

    expect(project.label).toBe("acme/repo/templates/engine");
    expect(project.files).toEqual(["package.json", "src/engine.ts"]);
    expect(
      JSON.parse(readFileSync(join(project.directory, "package.json"), "utf8")),
    ).toMatchObject({ name: "my-engine", private: true });
    expect(readFileSync(join(project.directory, "src/engine.ts"), "utf8")).toBe(
      "export const ready = true;\n",
    );
    expect(() =>
      readFileSync(join(project.directory, "README.md"), "utf8"),
    ).toThrow();
  });

  it("refuses redirected archive downloads", async () => {
    const cwd = createWorkingDirectory();
    const info = parseExampleReference("https://github.com/acme/repo");
    const resolved: ExampleRepoInfo = { ...info, branch: "main" };
    const fetchImpl: ExampleFetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/tarball" },
      });
    };

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: resolved,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_UNAVAILABLE" });
    expect(() =>
      readFileSync(join(cwd, "my-engine", "package.json"), "utf8"),
    ).toThrow();
  });

  it("does not retain target files when the archive lacks package.json after extract", async () => {
    const cwd = createWorkingDirectory();
    const archive = await buildRepositoryArchive({
      rootName: "repo-main",
      files: {
        "templates/engine/README.md": "no package\n",
      },
    });
    const { info, fetchImpl } = await resolveTreeExample(
      "https://github.com/acme/repo/tree/main/templates/engine",
      archive,
      "templates/engine/package.json",
    );

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "EXAMPLE_UNAVAILABLE",
      details: ["package.json"],
    });
  });

  it("rejects symlink archives with sanitized EXAMPLE_FAILED without crashing", async () => {
    const cwd = createWorkingDirectory();
    const archive = await buildRepositoryArchive({
      rootName: "repo-main",
      files: {
        "package.json": '{"name":"template"}\n',
      },
      symlinks: {
        "linked.txt": "package.json",
      },
    });
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };
    const fetchImpl = createFetch({ archive });

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
    expect(() =>
      readFileSync(join(cwd, "my-engine", "package.json"), "utf8"),
    ).toThrow();
  });

  it("rejects archives that exceed the uncompressed byte limit during extract", async () => {
    const cwd = createWorkingDirectory();
    const archive = await buildRepositoryArchive({
      rootName: "repo-main",
      files: {
        "package.json": '{"name":"template"}\n',
        "big.bin": "0123456789abcdef",
      },
    });
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };
    const fetchImpl = createFetch({ archive });

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: fetchImpl,
        limits: { maxArchiveBytes: 20 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
  });

  it("rejects archives that exceed the per-file byte limit during extract", async () => {
    const cwd = createWorkingDirectory();
    const archive = await buildRepositoryArchive({
      rootName: "repo-main",
      files: {
        "package.json": '{"name":"template"}\n',
        "big.bin": "0123456789abcdef",
      },
    });
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };
    const fetchImpl = createFetch({ archive });

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: fetchImpl,
        limits: { maxFileBytes: 8 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
  });

  it("rejects archives that exceed the extracted file count during extract", async () => {
    const cwd = createWorkingDirectory();
    const archive = await buildRepositoryArchive({
      rootName: "repo-main",
      files: {
        "package.json": '{"name":"template"}\n',
        "a.txt": "a\n",
        "b.txt": "b\n",
      },
    });
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };
    const fetchImpl = createFetch({ archive });

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: fetchImpl,
        limits: { maxExtractedFiles: 2 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
  });
});
