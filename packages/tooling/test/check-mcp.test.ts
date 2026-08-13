import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { checkMcp } from "../src/check-mcp.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const commandPath = "packages/tooling/dist/cli.js";
const fixtureDirectory = "packages/tooling/test/fixtures";

function fixture(name: string): string {
  return `${fixtureDirectory}/${name}`;
}

function runCommand(...args: readonly string[]) {
  const result = spawnSync(process.execPath, [commandPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function runCheck(...args: readonly string[]) {
  const stderr: string[] = [];
  return {
    stderr,
    exitCode: checkMcp({
      argv: args,
      cwd: repositoryRoot,
      io: {
        writeStderr: (text) => {
          stderr.push(text);
        },
      },
    }),
  };
}

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/core",
      "packages/mcp",
      "packages/tooling",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

describe("invokta check-mcp", () => {
  it("exits 0 without output for a portable, unique published catalog", () => {
    const result = runCommand("check-mcp", fixture("valid-engine.js"));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("fails before adapter startup when capability IDs collide as MCP names", () => {
    const result = runCommand("check-mcp", fixture("colliding-mcp-engine.js"));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`invokta: the MCP tool catalog is invalid.
module: "${fixture("colliding-mcp-engine.js")}"
export: "engine"
issue: code="MCP_TOOL_NAME_COLLISION" toolName="support_echo" capabilityIds=2
  capability: id="support.echo"
  capability: id="support_echo"
`);
  });

  it("supports a non-default engine export", async () => {
    const run = runCheck(
      "check-mcp",
      fixture("valid-engine.js"),
      "--export",
      "supportEngine",
    );

    await expect(run.exitCode).resolves.toBe(0);
    expect(run.stderr).toEqual([]);
  });

  it("rejects a missing engine module", async () => {
    const run = runCheck("check-mcp");

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain("A module path is required.");
    expect(run.stderr.join("")).toContain(
      "invokta check-mcp <esm-module> [--export <name>]",
    );
  });

  it("rejects an export that is not an Invokta engine", async () => {
    const run = runCheck(
      "check-mcp",
      fixture("valid-composition.js"),
      "--export",
      "capabilities",
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "the selected export is not a usable Invokta engine",
    );
  });

  it("rejects a missing requested export", async () => {
    const run = runCheck(
      "check-mcp",
      fixture("valid-engine.js"),
      "--export",
      "missingEngine",
    );

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain(
      "the module does not provide the requested export",
    );
  });

  it("contains application module failures without echoing their messages", async () => {
    const run = runCheck("check-mcp", fixture("load-failure.js"));

    await expect(run.exitCode).resolves.toBe(2);
    expect(run.stderr.join("")).toContain("the module could not be loaded");
    expect(run.stderr.join("")).not.toContain(
      "Fixture module evaluation failed",
    );
  });

  it("rejects unknown options without writing to stdout", () => {
    const result = runCommand(
      "check-mcp",
      fixture("valid-engine.js"),
      "--verbose",
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Unknown option "--verbose"');
  });
});
