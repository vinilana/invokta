import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFilesystemObsidianVault,
  filesystemObsidianConnector,
} from "../src/infrastructure/filesystem-obsidian-vault.js";

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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("the filesystem Obsidian knowledge graph", () => {
  it("exposes the graph through a typed filesystem connector", () => {
    const connector = filesystemObsidianConnector.create(
      { vaultPath: "/path/that/does/not/exist" },
      {},
    );

    expect(filesystemObsidianConnector.name).toBe("filesystem-obsidian");
    expect(Object.keys(connector.ports)).toEqual(["graph"]);
    expect(() =>
      filesystemObsidianConnector.create({ vaultPath: "" }, {}),
    ).toThrow("Connector configuration is invalid.");
  });

  it("performs no filesystem I/O during connector construction", () => {
    expect(() =>
      createFilesystemObsidianVault({
        vaultPath: "/path/that/does/not/exist",
      }),
    ).not.toThrow();
  });

  it("lists explicit root indexes with bounded, allowlisted frontmatter", async () => {
    const vaultPath = await createVault();
    const outsidePath = join(await createVault(), "outside.md");
    await writeNote(
      vaultPath,
      "indexes/architecture.md",
      `---
id: architecture
kind: index
entrypoint: true
title: Architecture
summary: System boundaries
topics: [architecture, agents]
updated: 2026-07-28
privateToken: never-return-this
---
# Architecture
`,
    );
    await writeNote(
      vaultPath,
      "indexes/internal.md",
      `---
id: internal
kind: index
entrypoint: false
---
# Internal
`,
    );
    await writeNote(
      vaultPath,
      ".obsidian/metadata.md",
      `---
id: hidden
kind: index
entrypoint: true
---
# Hidden
`,
    );
    await writeFile(
      outsidePath,
      `---
id: outside
kind: index
entrypoint: true
---
# Outside
`,
    );
    await symlink(outsidePath, join(vaultPath, "linked.md"));
    const graph = createFilesystemObsidianVault({ vaultPath });

    const result = await graph.listRoots(
      { maxRoots: 50 },
      { signal: signal() },
    );

    expect(result).toEqual({
      roots: [
        {
          id: "architecture",
          title: "Architecture",
          path: "indexes/architecture.md",
          frontmatter: {
            id: "architecture",
            kind: "index",
            entrypoint: true,
            title: "Architecture",
            summary: "System boundaries",
            topics: ["architecture", "agents"],
            updated: "2026-07-28",
          },
        },
      ],
      invalidNodeCount: 0,
      truncated: false,
    });
  });

  it("opens a node with its content, related index frontmatter, and navigable wikilinks", async () => {
    const vaultPath = await createVault();
    await writeNote(
      vaultPath,
      "indexes/architecture.md",
      `---
id: architecture
kind: index
entrypoint: true
title: Architecture
summary: System boundaries
---
# Architecture
`,
    );
    await writeNote(
      vaultPath,
      "guides/capability-contracts.md",
      `---
id: capability-contracts
kind: guide
title: Capability contracts
status: published
indexes: [architecture, missing-index]
privateToken: never-return-this
---
# Capability contracts

Use explicit contracts. Continue with [[Next decision|the next decision]] or [[Missing note]].
`,
    );
    await writeNote(
      vaultPath,
      "decisions/next-decision.md",
      `---
id: next-decision
kind: decision
title: Next decision
indexes: [architecture]
---
# Next decision
`,
    );
    const graph = createFilesystemObsidianVault({ vaultPath });

    const result = await graph.openNode(
      {
        id: "capability-contracts",
        contentOffset: 0,
        maxContentCharacters: 20_000,
        maxRelatedIndexes: 20,
        maxOutgoingLinks: 50,
      },
      { signal: signal() },
    );

    expect(result).toMatchObject({
      found: true,
      node: {
        id: "capability-contracts",
        title: "Capability contracts",
        path: "guides/capability-contracts.md",
        frontmatter: {
          id: "capability-contracts",
          kind: "guide",
          title: "Capability contracts",
          status: "published",
          indexes: ["architecture", "missing-index"],
        },
        content:
          "# Capability contracts\n\nUse explicit contracts. Continue with [[Next decision|the next decision]] or [[Missing note]].\n",
        contentOffset: 0,
        contentTruncated: false,
      },
      relatedIndexes: [
        {
          id: "architecture",
          title: "Architecture",
          path: "indexes/architecture.md",
          frontmatter: {
            id: "architecture",
            kind: "index",
            entrypoint: true,
            title: "Architecture",
            summary: "System boundaries",
          },
        },
      ],
      outgoingLinks: [
        {
          reference: "Next decision",
          id: "next-decision",
          title: "Next decision",
          path: "decisions/next-decision.md",
        },
      ],
      unresolvedLinks: ["Missing note"],
      unresolvedIndexes: ["missing-index"],
      invalidNodeCount: 0,
      relationsTruncated: false,
    });
    expect(result.node?.frontmatter).not.toHaveProperty("privateToken");
    expect(result.node?.contentLength).toBe(result.node?.content.length);
  });

  it("returns a not-found result for an unknown stable ID", async () => {
    const vaultPath = await createVault();
    const graph = createFilesystemObsidianVault({ vaultPath });

    await expect(
      graph.openNode(
        {
          id: "unknown",
          contentOffset: 0,
          maxContentCharacters: 20_000,
          maxRelatedIndexes: 20,
          maxOutgoingLinks: 50,
        },
        { signal: signal() },
      ),
    ).resolves.toEqual({
      found: false,
      node: null,
      relatedIndexes: [],
      outgoingLinks: [],
      unresolvedLinks: [],
      unresolvedIndexes: [],
      invalidNodeCount: 0,
      relationsTruncated: false,
    });
  });

  it("pages node content without reinterpreting the frontmatter", async () => {
    const vaultPath = await createVault();
    await writeNote(
      vaultPath,
      "long.md",
      `---
id: long-note
kind: guide
---
0123456789abcdef`,
    );
    const graph = createFilesystemObsidianVault({ vaultPath });

    const result = await graph.openNode(
      {
        id: "long-note",
        contentOffset: 4,
        maxContentCharacters: 6,
        maxRelatedIndexes: 20,
        maxOutgoingLinks: 50,
      },
      { signal: signal() },
    );

    expect(result.node).toMatchObject({
      content: "456789",
      contentOffset: 4,
      contentLength: 16,
      contentTruncated: true,
    });
  });

  it("counts malformed frontmatter while ignoring ordinary notes without IDs", async () => {
    const vaultPath = await createVault();
    await writeNote(vaultPath, "ordinary.md", "# Ordinary note");
    await writeNote(
      vaultPath,
      "malformed.md",
      "---\nid: [unterminated\n---\n# Malformed",
    );
    const graph = createFilesystemObsidianVault({ vaultPath });

    const result = await graph.listRoots(
      { maxRoots: 50 },
      { signal: signal() },
    );

    expect(result).toEqual({
      roots: [],
      invalidNodeCount: 1,
      truncated: false,
    });
  });

  it("fails deterministically when stable node IDs are duplicated", async () => {
    const vaultPath = await createVault();
    await writeNote(vaultPath, "a.md", "---\nid: duplicate\n---\n# A");
    await writeNote(vaultPath, "b.md", "---\nid: duplicate\n---\n# B");
    const graph = createFilesystemObsidianVault({ vaultPath });

    await expect(
      graph.listRoots({ maxRoots: 50 }, { signal: signal() }),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "The Obsidian vault contains duplicate node IDs.",
      publicDetails: { id: "duplicate" },
    });
  });

  it("gives exact stable IDs precedence over ambiguous titles", async () => {
    const vaultPath = await createVault();
    await writeNote(
      vaultPath,
      "stable.md",
      "---\nid: stable-id\ntitle: Canonical node\n---\n# Canonical",
    );
    await writeNote(
      vaultPath,
      "collision.md",
      "---\nid: another-node\ntitle: stable-id\n---\n# Collision",
    );
    await writeNote(
      vaultPath,
      "source.md",
      "---\nid: source\n---\nContinue with [[stable-id]].",
    );
    const graph = createFilesystemObsidianVault({ vaultPath });

    const opened = await graph.openNode(
      {
        id: "source",
        contentOffset: 0,
        maxContentCharacters: 20_000,
        maxRelatedIndexes: 20,
        maxOutgoingLinks: 50,
      },
      { signal: signal() },
    );

    expect(opened.outgoingLinks).toEqual([
      {
        reference: "stable-id",
        id: "stable-id",
        title: "Canonical node",
        path: "stable.md",
      },
    ]);
    expect(opened.unresolvedLinks).toEqual([]);
  });

  it("bounds roots and one-level relations deterministically", async () => {
    const vaultPath = await createVault();
    await writeNote(
      vaultPath,
      "a-index.md",
      "---\nid: a-index\nkind: index\nentrypoint: true\n---\n# A",
    );
    await writeNote(
      vaultPath,
      "b-index.md",
      "---\nid: b-index\nkind: index\nentrypoint: true\n---\n# B",
    );
    await writeNote(
      vaultPath,
      "node.md",
      `---
id: node
indexes: [a-index, b-index]
---
[[A]] and [[B]]`,
    );
    const graph = createFilesystemObsidianVault({ vaultPath });

    const roots = await graph.listRoots({ maxRoots: 1 }, { signal: signal() });
    const opened = await graph.openNode(
      {
        id: "node",
        contentOffset: 0,
        maxContentCharacters: 20_000,
        maxRelatedIndexes: 1,
        maxOutgoingLinks: 1,
      },
      { signal: signal() },
    );

    expect(roots.roots.map(({ id }) => id)).toEqual(["a-index"]);
    expect(roots.truncated).toBe(true);
    expect(opened.relatedIndexes.map(({ id }) => id)).toEqual(["a-index"]);
    expect(opened.outgoingLinks.map(({ id }) => id)).toEqual(["a-index"]);
    expect(opened.relationsTruncated).toBe(true);
  });

  it("fails when the vault file-count limit is exceeded", async () => {
    const vaultPath = await createVault();
    await writeNote(vaultPath, "a.md", "# A");
    await writeNote(vaultPath, "b.md", "# B");
    const graph = createFilesystemObsidianVault({ vaultPath, maxFiles: 1 });

    await expect(
      graph.listRoots({ maxRoots: 50 }, { signal: signal() }),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      publicDetails: { limit: 1 },
    });
  });

  it("honors cancellation before touching the vault", async () => {
    const graph = createFilesystemObsidianVault({
      vaultPath: "/path/that/does/not/exist",
    });
    const controller = new AbortController();
    controller.abort(new Error("The caller stopped graph navigation."));

    await expect(
      graph.listRoots({ maxRoots: 50 }, { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
  });
});
