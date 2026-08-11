import { describe, expect, it } from "vitest";

import { runInspectOAuth } from "../src/inspect-oauth.js";
import { createTestContext } from "./support/test-context.js";

const invalidUsageText = 'Invalid arguments. Run "invokta-deploy --help".\n';

async function run(args: readonly string[]) {
  const harness = createTestContext();
  const exitCode = await runInspectOAuth(args, harness.context);
  return { exitCode, stdout: harness.stdout, stderr: harness.stderr };
}

describe("runInspectOAuth usage", () => {
  it.each([
    ["no arguments", []],
    ["a missing URL value", ["--url"]],
    ["a relative URL", ["--url", "/mcp"]],
    ["a non-MCP path", ["--url", "https://engine.example/"]],
    ["URL userinfo", ["--url", "https://user@engine.example/mcp"]],
    ["a query", ["--url", "https://engine.example/mcp?token=secret"]],
    ["a public HTTP URL", ["--url", "http://engine.example/mcp"]],
    ["localhost HTTP", ["--url", "http://localhost:3000/mcp"]],
    ["an unknown flag", ["--url", "https://engine.example/mcp", "--json"]],
    [
      "a repeated URL",
      ["--url", "https://a.example/mcp", "--url", "https://b.example/mcp"],
    ],
    [
      "a zero timeout",
      ["--url", "https://engine.example/mcp", "--timeout-ms", "0"],
    ],
    [
      "an excessive timeout",
      ["--url", "https://engine.example/mcp", "--timeout-ms", "60001"],
    ],
  ])("rejects %s without echoing arguments", async (_label, args) => {
    const result = await run(args);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([invalidUsageText]);
    expect(result.stderr.join("")).not.toContain("token=secret");
  });
});
