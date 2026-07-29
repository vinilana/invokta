import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { SupportHarness, supportCapabilityId } from "../src/support-harness.js";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedClassification = {
  category: "billing",
  confidence: 0.9,
  rationale: "The ticket contains language associated with billing.",
};

beforeAll(async () => {
  const { spawnSync } = await import("node:child_process");
  const build = spawnSync(
    process.execPath,
    [
      "../../node_modules/typescript/bin/tsc",
      "-b",
      "../support-engine",
      ".",
      "--pretty",
      "false",
    ],
    { cwd: exampleRoot, encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(
      `Harness fixture build failed:\n${build.stdout}${build.stderr}`,
    );
  }
});

describe("the private support harness", () => {
  it("discovers and calls the support tool over MCP while owning its execution history", async () => {
    const harness = new SupportHarness();

    const snapshot = await harness.classifyTicket("T-123");

    expect(snapshot).toEqual({
      discoveredTools: [supportCapabilityId],
      messages: [
        {
          role: "user",
          content: "Classify support ticket T-123.",
        },
        {
          role: "assistant",
          content: JSON.stringify(expectedClassification),
        },
      ],
      executions: [
        {
          toolName: supportCapabilityId,
          arguments: { ticketId: "T-123" },
          isError: false,
          result: expectedClassification,
        },
      ],
    });
  });

  it("records a safe MCP tool error without discarding the failed execution", async () => {
    const harness = new SupportHarness();
    const safeError = {
      code: "FORBIDDEN",
      message: "Capability access is forbidden.",
    };

    const snapshot = await harness.classifyTicket("T-999");

    expect(snapshot).toEqual({
      discoveredTools: [supportCapabilityId],
      messages: [
        {
          role: "user",
          content: "Classify support ticket T-999.",
        },
        {
          role: "assistant",
          content: JSON.stringify(safeError),
        },
      ],
      executions: [
        {
          toolName: supportCapabilityId,
          arguments: { ticketId: "T-999" },
          isError: true,
          result: safeError,
        },
      ],
    });
  });

  it("depends only on the official MCP client instead of engine internals", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly private?: boolean;
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({
      "@modelcontextprotocol/sdk": "1.30.0",
    });

    const sourceDirectory = new URL("../src/", import.meta.url);
    const sourceFiles = (await readdir(sourceDirectory)).filter((file) =>
      file.endsWith(".ts"),
    );
    const source = (
      await Promise.all(
        sourceFiles.map((file) =>
          readFile(new URL(file, sourceDirectory), "utf8"),
        ),
      )
    ).join("\n");

    expect(source).not.toMatch(/@ai-engine\//u);
    expect(source).not.toContain("support-engine/src");
    expect(source).not.toContain(".invoke(");
    expect(source).not.toContain(".run(");
    expect(source).not.toContain("createSupportEngine");
    expect(source).not.toContain("createClassifyTicket");
    expect(
      [...source.matchAll(/support-engine\/[^"']+/gu)].map(
        ([reference]) => reference,
      ),
    ).toEqual(["support-engine/dist/mcp-stdio.js"]);
  });
});
