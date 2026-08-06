import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { link, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
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

function createUstarHeader(
  name: string,
  size: number,
  typeflag: string,
): Buffer {
  const header = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(name);
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.byteLength, 100));
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
  );
  header.write("        ", 148);
  header.write(typeflag, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += header[index] ?? 0;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

function createUstarEntry(
  name: string,
  content: string | Buffer,
  typeflag: string,
): Buffer {
  const data = typeof content === "string" ? Buffer.from(content) : content;
  const header = createUstarHeader(name, data.byteLength, typeflag);
  const padding = (512 - (data.byteLength % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(padding)]);
}

/** Build a PAX `size=` record with a correct length prefix. */
function createPaxSizeRecord(size: number): Buffer {
  const payload = `size=${size}\n`;
  let lengthDigits = 1;
  while (true) {
    const length = lengthDigits + 1 + payload.length;
    if (String(length).length === lengthDigits) {
      return Buffer.from(`${length} ${payload}`);
    }
    lengthDigits += 1;
  }
}

function buildRawTarGz(
  entries: ReadonlyArray<
    Readonly<{ name: string; content?: string | Buffer; typeflag: string }>
  >,
): Buffer {
  const parts = entries.map((entry) =>
    createUstarEntry(entry.name, entry.content ?? "", entry.typeflag),
  );
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

async function buildRepositoryArchive(options: {
  readonly rootName: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly symlinks?: Readonly<Record<string, string>>;
  readonly hardlinks?: Readonly<Record<string, string>>;
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
  for (const [relativePath, target] of Object.entries(
    options.hardlinks ?? {},
  )) {
    const absolute = join(root, options.rootName, relativePath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await link(join(root, options.rootName, target), absolute);
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

  it("recovers slash-containing refs when --example-path is provided", () => {
    expect(
      parseExampleReference(
        "https://github.com/acme/repo/tree/feature/foo/templates/engine",
        "templates/engine",
      ),
    ).toEqual({
      owner: "acme",
      repository: "repo",
      branch: "feature/foo",
      filePath: "templates/engine",
      label: "acme/repo/templates/engine",
    });
    expect(
      parseExampleReference(
        "https://github.com/acme/repo/tree/main/ignored",
        "templates/engine",
      ),
    ).toEqual({
      owner: "acme",
      repository: "repo",
      branch: "main/ignored",
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
      "https://github.com/acme/repo/tree/main/evil%1Bpath",
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
    const fetchImpl = createFetch({
      packagePaths: new Set(["templates/engine/package.json"]),
      archive,
    });
    const info = await resolveExampleReference(
      "https://github.com/acme/repo/tree/main/templates/engine",
      undefined,
      fetchImpl,
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
  });

  it("rejects symlink and hardlink archives without crashing", async () => {
    const cwd = createWorkingDirectory();
    for (const archive of [
      await buildRepositoryArchive({
        rootName: "repo-main",
        files: { "package.json": '{"name":"template"}\n' },
        symlinks: { "linked.txt": "package.json" },
      }),
      await buildRepositoryArchive({
        rootName: "repo-main",
        files: { "package.json": '{"name":"template"}\n' },
        hardlinks: { "linked.txt": "package.json" },
      }),
    ]) {
      const info: ExampleRepoInfo = {
        owner: "acme",
        repository: "repo",
        branch: "main",
        filePath: "",
        label: "acme/repo",
      };
      await expect(
        createExampleProject({
          cwd,
          target: "my-engine",
          example: info,
          fetch: createFetch({ archive }),
        }),
      ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
    }
  });

  it("rejects ContiguousFile entries that exceed extract limits", async () => {
    const cwd = createWorkingDirectory();
    const archive = buildRawTarGz([
      { name: "repo-main/", typeflag: "5" },
      {
        name: "repo-main/package.json",
        content: '{"n":1}\n',
        typeflag: "0",
      },
      {
        name: "repo-main/big.bin",
        content: "0123456789abcdef",
        typeflag: "7", // ContiguousFile
      },
    ]);
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: createFetch({ archive }),
        limits: { maxFileBytes: 12 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
    expect(() =>
      readFileSync(join(cwd, "my-engine", "package.json"), "utf8"),
    ).toThrow();
  });

  it("rejects SparseFile entries that node-tar would otherwise ignore", async () => {
    const cwd = createWorkingDirectory();
    const archive = buildRawTarGz([
      {
        name: "repo-main/package.json",
        content: '{"name":"template"}\n',
        typeflag: "0",
      },
      {
        name: "repo-main/sparse.bin",
        content: "0123456789abcdef",
        typeflag: "S",
      },
    ]);
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: createFetch({ archive }),
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
  });

  it("rejects SparseFile hidden by a PAX size override desync", async () => {
    // PAX size=0 makes node-tar treat the next file as empty, while the ustar
    // size claims enough bytes to swallow a following SparseFile header. A
    // scanner that ignores PAX size never sees typeflag S and would accept.
    const cwd = createWorkingDirectory();
    const sparseEntry = createUstarEntry(
      "repo-main/sparse.bin",
      "0123456789abcdef",
      "S",
    );
    const archive = gzipSync(
      Buffer.concat([
        createUstarEntry(
          "repo-main/package.json",
          '{"name":"template"}\n',
          "0",
        ),
        createUstarEntry("PaxHeader/decoy", createPaxSizeRecord(0), "x"),
        createUstarHeader("repo-main/decoy.bin", sparseEntry.byteLength, "0"),
        sparseEntry,
        Buffer.alloc(1024),
      ]),
    );
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: createFetch({ archive }),
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
    expect(() =>
      readFileSync(join(cwd, "my-engine", "package.json"), "utf8"),
    ).toThrow();
  });

  it("rejects absolute archive entry paths", async () => {
    const cwd = createWorkingDirectory();
    const archive = buildRawTarGz([
      {
        name: "/package.json",
        content: '{"name":"template"}\n',
        typeflag: "0",
      },
      {
        name: "/src/engine.ts",
        content: "export {}\n",
        typeflag: "0",
      },
    ]);
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: createFetch({ archive }),
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
  });

  it("rejects a directory named package.json", async () => {
    const cwd = createWorkingDirectory();
    const archive = buildRawTarGz([
      { name: "repo-main/", typeflag: "5" },
      { name: "repo-main/package.json/", typeflag: "5" },
      {
        name: "repo-main/package.json/readme.txt",
        content: "not a manifest\n",
        typeflag: "0",
      },
    ]);
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: createFetch({ archive }),
      }),
    ).rejects.toMatchObject({
      code: "EXAMPLE_UNAVAILABLE",
      details: ["package.json"],
    });
  });

  it("rejects archives that exceed uncompressed, file-count, and directory limits", async () => {
    const cwd = createWorkingDirectory();
    const archive = await buildRepositoryArchive({
      rootName: "repo-main",
      files: {
        "package.json": '{"name":"template"}\n',
        "nested/a.txt": "a\n",
        "nested/b.txt": "b\n",
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
        target: "bytes",
        example: info,
        fetch: fetchImpl,
        limits: { maxArchiveBytes: 20 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });

    await expect(
      createExampleProject({
        cwd,
        target: "files",
        example: info,
        fetch: fetchImpl,
        limits: { maxExtractedFiles: 2 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });

    await expect(
      createExampleProject({
        cwd,
        target: "dirs",
        example: info,
        fetch: fetchImpl,
        limits: { maxExtractedDirectories: 0 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
  });

  it("counts implicit parent directories from file paths toward the directory cap", async () => {
    const cwd = createWorkingDirectory();
    // No directory headers — only nested files, which still create dirs on extract.
    const archive = buildRawTarGz([
      {
        name: "repo-main/package.json",
        content: '{"name":"template"}\n',
        typeflag: "0",
      },
      {
        name: "repo-main/a/b/file.txt",
        content: "nested\n",
        typeflag: "0",
      },
    ]);
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: createFetch({ archive }),
        limits: { maxExtractedDirectories: 1 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_FAILED" });
  });

  it("rejects compressed downloads that exceed the compressed-byte cap", async () => {
    const cwd = createWorkingDirectory();
    const archive = await buildRepositoryArchive({
      rootName: "repo-main",
      files: {
        "package.json": '{"name":"template"}\n',
      },
    });
    const info: ExampleRepoInfo = {
      owner: "acme",
      repository: "repo",
      branch: "main",
      filePath: "",
      label: "acme/repo",
    };

    await expect(
      createExampleProject({
        cwd,
        target: "my-engine",
        example: info,
        fetch: createFetch({ archive }),
        limits: { maxCompressedArchiveBytes: 8 },
      }),
    ).rejects.toMatchObject({ code: "EXAMPLE_UNAVAILABLE" });
  });

  it("surfaces fetch timeouts as EXAMPLE_UNAVAILABLE", async () => {
    const fetchImpl: ExampleFetch = async (_input, init) =>
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("test should have aborted"));
        }, 1_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });

    await expect(
      resolveExampleReference(
        "https://github.com/acme/repo",
        undefined,
        fetchImpl,
        { fetchTimeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ code: "EXAMPLE_UNAVAILABLE" });
  });
});

describe("success output sanitization", () => {
  it("escapes control characters the success renderer would emit", () => {
    const hostile = "acme/repo/\u001b[31mevil";
    const line = `Created my-engine from example ${sanitizeDiagnosticDetail(hostile)}.`;
    expect(line).not.toContain("\u001b");
    expect(line).toContain("\\u001b");
    expect(line).toContain("from example acme/repo/");
  });
});
