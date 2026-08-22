import { toMcpToolName, validateMcpToolCatalog } from "@invokta/mcp";
import { describe, expect, it, vi } from "vitest";

import type { VaultKnowledgeGraph } from "../src/application/ports.js";
import { createObsidianContextEngine } from "../src/engine.js";

const principal = { id: "test:reader" };

function createGraph(): VaultKnowledgeGraph {
  return {
    listRoots: vi.fn(async () => ({
      roots: [
        {
          id: "architecture",
          title: "Architecture",
          path: "indexes/architecture.md",
          frontmatter: {
            id: "architecture",
            kind: "index",
            entrypoint: true,
            summary: "System boundaries",
          },
        },
      ],
      invalidNodeCount: 0,
      truncated: false,
    })),
    openNode: vi.fn(async () => ({
      found: true,
      node: {
        id: "capability-contracts",
        title: "Capability contracts",
        path: "guides/capability-contracts.md",
        frontmatter: {
          id: "capability-contracts",
          kind: "guide",
          indexes: ["architecture"],
        },
        content: "# Capability contracts\n\nUse explicit contracts.",
        contentOffset: 0,
        contentLength: 47,
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
      unresolvedLinks: [],
      unresolvedIndexes: [],
      invalidNodeCount: 0,
      relationsTruncated: false,
    })),
  };
}

describe("the Obsidian context engine example", () => {
  it("lists bounded context roots through an injected graph", async () => {
    const graph = createGraph();
    const engine = createObsidianContextEngine({ graph });

    const result = await engine.invoke(
      "knowledge.list-context-roots",
      {},
      { principal },
    );

    expect(result.roots).toEqual([
      {
        id: "architecture",
        title: "Architecture",
        path: "indexes/architecture.md",
        frontmatter: {
          id: "architecture",
          kind: "index",
          entrypoint: true,
          summary: "System boundaries",
        },
      },
    ]);
    expect(graph.listRoots).toHaveBeenCalledExactlyOnceWith(
      { maxRoots: 50 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("opens one node with bounded content and one level of graph context", async () => {
    const graph = createGraph();
    const engine = createObsidianContextEngine({ graph });

    const result = await engine.invoke(
      "knowledge.open-context-node",
      { id: "  capability-contracts  " },
      { principal },
    );

    expect(result).toMatchObject({
      found: true,
      node: {
        id: "capability-contracts",
        content: "# Capability contracts\n\nUse explicit contracts.",
      },
      relatedIndexes: [{ id: "architecture" }],
      outgoingLinks: [{ id: "next-decision" }],
    });
    expect(graph.openNode).toHaveBeenCalledExactlyOnceWith(
      {
        id: "capability-contracts",
        contentOffset: 0,
        maxContentCharacters: 20_000,
        maxRelatedIndexes: 20,
        maxOutgoingLinks: 50,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("passes content pagination to the graph", async () => {
    const graph = createGraph();
    const engine = createObsidianContextEngine({ graph });

    await engine.invoke(
      "knowledge.open-context-node",
      {
        id: "capability-contracts",
        contentOffset: 20_000,
        maxContentCharacters: 5_000,
      },
      { principal },
    );

    expect(graph.openNode).toHaveBeenCalledWith(
      expect.objectContaining({
        contentOffset: 20_000,
        maxContentCharacters: 5_000,
      }),
      expect.anything(),
    );
  });

  it.each([
    ["empty node ID", { id: "   " }],
    ["invalid node ID", { id: "Architecture note" }],
    ["negative content offset", { id: "architecture", contentOffset: -1 }],
    [
      "oversized content page",
      { id: "architecture", maxContentCharacters: 20_001 },
    ],
  ])("rejects %s before reading the graph", async (_description, input) => {
    const graph = createGraph();
    const engine = createObsidianContextEngine({ graph });

    await expect(
      engine.invoke("knowledge.open-context-node", input, { principal }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(graph.openNode).not.toHaveBeenCalled();
  });

  it("denies anonymous callers before reading the graph", async () => {
    const graph = createGraph();
    const engine = createObsidianContextEngine({ graph });

    await expect(
      engine.invoke("knowledge.list-context-roots", {}),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      engine.invoke("knowledge.open-context-node", { id: "architecture" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(graph.listRoots).not.toHaveBeenCalled();
    expect(graph.openNode).not.toHaveBeenCalled();
  });

  it("publishes two read-only graph navigation contracts", () => {
    const engine = createObsidianContextEngine({ graph: createGraph() });

    expect(engine.list().map(({ id }) => id)).toEqual([
      "knowledge.list-context-roots",
      "knowledge.open-context-node",
    ]);
    expect(engine.describe("knowledge.list-context-roots")).toMatchObject({
      title: "List context roots",
      timeoutMs: 15_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(engine.describe("knowledge.open-context-node")).toMatchObject({
      title: "Open context node",
      timeoutMs: 15_000,
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          contentOffset: { type: "integer", minimum: 0 },
          maxContentCharacters: {
            type: "integer",
            minimum: 1,
            maximum: 20_000,
          },
        },
      },
    });
  });

  it("publishes one unique portable MCP tool name for every capability", () => {
    const engine = createObsidianContextEngine({ graph: createGraph() });

    // The same catalog construction `invokta check-mcp` runs as a build-time
    // gate: a capability ID whose derived alias collides with another one's
    // fails here instead of when an MCP adapter starts.
    expect(() => {
      validateMcpToolCatalog(engine);
    }).not.toThrow();
    expect(
      engine.list().map((capability) => toMcpToolName(capability.id)),
    ).toEqual(["knowledge_list-context-roots", "knowledge_open-context-node"]);
  });
});
