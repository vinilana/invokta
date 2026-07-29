import { describe, expect, it, vi } from "vitest";

import type { VaultContextProvider } from "../src/application/ports.js";
import { createObsidianContextEngine } from "../src/engine.js";

describe("the Obsidian context engine example", () => {
  it("provides bounded vault context through an injected dependency", async () => {
    const context: VaultContextProvider = {
      provide: vi.fn(async () => ({
        context:
          "## Agent design\nSource: notes/agent-design.md\n\nUse explicit contracts.",
        sources: [{ path: "notes/agent-design.md", title: "Agent design" }],
        truncated: false,
      })),
    };
    const engine = createObsidianContextEngine({ context });

    const result = await engine.invoke(
      "obsidian.provide-context",
      { query: "  agent contracts  ", maxNotes: 2 },
      { principal: { id: "test:reader" } },
    );

    expect(result).toEqual({
      query: "agent contracts",
      context:
        "## Agent design\nSource: notes/agent-design.md\n\nUse explicit contracts.",
      sources: [{ path: "notes/agent-design.md", title: "Agent design" }],
      truncated: false,
    });
    expect(context.provide).toHaveBeenCalledExactlyOnceWith(
      { query: "agent contracts", maxNotes: 2, maxContextCharacters: 20_000 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("denies anonymous callers before reading the vault", async () => {
    const context: VaultContextProvider = { provide: vi.fn() };
    const engine = createObsidianContextEngine({ context });

    await expect(
      engine.invoke("obsidian.provide-context", { query: "agent contracts" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(context.provide).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty query", { query: "   " }],
    ["a query without searchable text", { query: "---" }],
    ["too many requested notes", { query: "agent", maxNotes: 11 }],
  ])("rejects %s before reading the vault", async (_description, input) => {
    const context: VaultContextProvider = { provide: vi.fn() };
    const engine = createObsidianContextEngine({ context });

    await expect(
      engine.invoke("obsidian.provide-context", input, {
        principal: { id: "test:reader" },
      }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(context.provide).not.toHaveBeenCalled();
  });

  it("rejects a source path that is not relative to the vault", async () => {
    const context: VaultContextProvider = {
      async provide() {
        return {
          context: "secret",
          sources: [{ path: "/private/secret.md", title: "Secret" }],
          truncated: false,
        };
      },
    };
    const engine = createObsidianContextEngine({ context });

    await expect(
      engine.invoke(
        "obsidian.provide-context",
        { query: "secret" },
        { principal: { id: "test:reader" } },
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });

  it("publishes a bounded, read-only capability contract", () => {
    const engine = createObsidianContextEngine({
      context: { provide: vi.fn() },
    });

    expect(engine.describe("obsidian.provide-context")).toMatchObject({
      id: "obsidian.provide-context",
      title: "Provide Obsidian vault context",
      timeoutMs: 15_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          maxNotes: { type: "integer", minimum: 1, maximum: 10 },
        },
      },
      outputSchema: { type: "object" },
    });
  });
});
