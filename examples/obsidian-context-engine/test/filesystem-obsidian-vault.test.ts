import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFilesystemObsidianVault } from "../src/infrastructure/filesystem-obsidian-vault.js";

const temporaryDirectories: string[] = [];

async function createVault(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "obsidian-context-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeNote(
  vaultPath: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const path = join(vaultPath, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("the filesystem Obsidian vault adapter", () => {
  it("ranks Markdown notes, extracts headings, and excludes vault metadata and symlinks", async () => {
    const vaultPath = await createVault();
    const outsidePath = join(await createVault(), "outside.md");
    await writeNote(
      vaultPath,
      "notes/agent-architecture.md",
      "# Agent Architecture\n\nUse explicit contracts for every agent capability.\n\nKeep adapters thin.",
    );
    await writeNote(
      vaultPath,
      "notes/secondary.md",
      "# Secondary\n\nAgent implementations are replaceable.",
    );
    await writeNote(vaultPath, "cooking.md", "# Cooking\n\nBake bread.");
    await writeNote(
      vaultPath,
      ".obsidian/internal.md",
      "# Internal\n\nagent contracts secret metadata",
    );
    await writeFile(outsidePath, "# Outside\n\nagent contracts outside secret");
    await symlink(outsidePath, join(vaultPath, "linked.md"));
    const provider = createFilesystemObsidianVault({ vaultPath });

    const result = await provider.provide(
      {
        query: "agent contracts",
        maxNotes: 2,
        maxContextCharacters: 20_000,
      },
      { signal: new AbortController().signal },
    );

    expect(result.sources).toEqual([
      {
        path: "notes/agent-architecture.md",
        title: "Agent Architecture",
      },
      { path: "notes/secondary.md", title: "Secondary" },
    ]);
    expect(result.context).toContain(
      "## Agent Architecture\nSource: notes/agent-architecture.md\n\nUse explicit contracts for every agent capability.",
    );
    expect(result.context).not.toContain("secret metadata");
    expect(result.context).not.toContain("outside secret");
    expect(result.truncated).toBe(false);
  });

  it("matches accents insensitively and orders equal scores by relative path", async () => {
    const vaultPath = await createVault();
    await writeNote(vaultPath, "b.md", "# B\n\nDecisões registradas.");
    await writeNote(vaultPath, "a.md", "# A\n\nDecisões registradas.");
    const provider = createFilesystemObsidianVault({ vaultPath });

    const result = await provider.provide(
      {
        query: "decisoes",
        maxNotes: 1,
        maxContextCharacters: 20_000,
      },
      { signal: new AbortController().signal },
    );

    expect(result.sources).toEqual([{ path: "a.md", title: "A" }]);
    expect(result.truncated).toBe(true);
  });

  it("bounds the assembled context and reports truncation", async () => {
    const vaultPath = await createVault();
    await writeNote(
      vaultPath,
      "long.md",
      `# Long note\n\ncontext ${"details ".repeat(100)}`,
    );
    const provider = createFilesystemObsidianVault({ vaultPath });

    const result = await provider.provide(
      { query: "context", maxNotes: 5, maxContextCharacters: 100 },
      { signal: new AbortController().signal },
    );

    expect(result.context.length).toBeLessThanOrEqual(100);
    expect(result.sources).toEqual([{ path: "long.md", title: "Long note" }]);
    expect(result.truncated).toBe(true);
  });

  it("skips an oversized note and marks an otherwise complete result as truncated", async () => {
    const vaultPath = await createVault();
    await writeNote(vaultPath, "large.md", "# Large\n\ncontext details");
    await writeNote(vaultPath, "small.md", "# Small\n\ncontext");
    const provider = createFilesystemObsidianVault({
      vaultPath,
      maxNoteBytes: 16,
    });

    const result = await provider.provide(
      { query: "context", maxNotes: 5, maxContextCharacters: 20_000 },
      { signal: new AbortController().signal },
    );

    expect(result.sources).toEqual([{ path: "small.md", title: "Small" }]);
    expect(result.truncated).toBe(true);
  });

  it("fails deterministically when the vault file-count limit is exceeded", async () => {
    const vaultPath = await createVault();
    await writeNote(vaultPath, "a.md", "# A");
    await writeNote(vaultPath, "b.md", "# B");
    const provider = createFilesystemObsidianVault({
      vaultPath,
      maxFiles: 1,
    });

    await expect(
      provider.provide(
        { query: "note", maxNotes: 1, maxContextCharacters: 20_000 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      publicDetails: { limit: 1 },
    });
  });

  it("honors cancellation before touching the vault", async () => {
    const provider = createFilesystemObsidianVault({
      vaultPath: "/path/that/does/not/exist",
    });
    const controller = new AbortController();
    controller.abort(new Error("The caller stopped the search."));

    await expect(
      provider.provide(
        { query: "agent", maxNotes: 1, maxContextCharacters: 20_000 },
        { signal: controller.signal },
      ),
    ).rejects.toBe(controller.signal.reason);
  });
});
