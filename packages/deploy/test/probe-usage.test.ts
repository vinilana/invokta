import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runProbe } from "../src/probe.js";
import { reserveClosedPort } from "./support/probe-server.js";
import { createTestContext } from "./support/test-context.js";

const invalidUsageText = 'Invalid arguments. Run "invokta-deploy --help".\n';
const secret = "sentinel-token-that-must-never-be-echoed";

let closedUrl = "";

beforeAll(async () => {
  closedUrl = `http://127.0.0.1:${String(await reserveClosedPort())}/mcp`;
});

afterAll(() => {
  closedUrl = "";
});

async function run(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const harness = createTestContext({ env });
  const exitCode = await runProbe(args, harness.context);
  return { exitCode, stdout: harness.stdout, stderr: harness.stderr };
}

async function expectUsageRejection(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const result = await run(args, env);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toEqual([]);
  expect(result.stderr).toEqual([invalidUsageText]);
}

describe("runProbe target URL rules", () => {
  it.each([
    ["an empty value", ""],
    ["a bare word", "mcp"],
    ["a relative path", "/mcp"],
    ["a protocol-relative authority", "//127.0.0.1/mcp"],
    ["a non-HTTP scheme", "ftp://127.0.0.1/mcp"],
    ["a file URL", "file:///mcp"],
    ["a WebSocket scheme", "ws://127.0.0.1/mcp"],
    ["userinfo with a password", "https://user:pass@engine.example/mcp"],
    ["userinfo without a password", "https://user@engine.example/mcp"],
    ["a query string", "https://engine.example/mcp?probe=1"],
    ["an empty query string", "https://engine.example/mcp?"],
    ["a fragment", "https://engine.example/mcp#top"],
    ["an empty fragment", "https://engine.example/mcp#"],
    ["the root path", "https://engine.example/"],
    ["no path", "https://engine.example"],
    ["a trailing slash", "https://engine.example/mcp/"],
    ["a different case", "https://engine.example/MCP"],
    ["a longer path", "https://engine.example/mcp/extra"],
    ["a mounted path with a trailing slash", "https://engine.example/a/mcp/"],
    ["a mounted path with an empty segment", "https://engine.example/a//mcp"],
    ["a mounted path with a dot segment", "https://engine.example/a/./mcp"],
    ["a mounted path with a parent segment", "https://engine.example/a/../mcp"],
    ["a mounted path with percent encoding", "https://engine.example/%61/mcp"],
    [
      "a mounted path with a reserved character",
      "https://engine.example/a:b/mcp",
    ],
    [
      "a mounted path longer than 256 bytes",
      `https://engine.example/${"a".repeat(253)}/mcp`,
    ],
    ["a percent-encoded path", "https://engine.example/%6dcp"],
    ["a dot segment", "https://engine.example/./mcp"],
    ["plain HTTP to a public host", "http://engine.example/mcp"],
    ["plain HTTP to a loopback name", "http://localhost:3000/mcp"],
    ["plain HTTP to a non-loopback address", "http://127.0.0.2:3000/mcp"],
    ["plain HTTP to another IPv6 address", "http://[::2]:3000/mcp"],
    ["a control character", "http://127.0.0.1:3000/mcp\n"],
    ["a tab character", "http://127.0.0.1:3000/m\tcp"],
    ["a space", "http://127.0.0.1:3000/mcp "],
  ])("rejects %s", async (_label, url) => {
    await expectUsageRejection(["--url", url]);
  });

  it("accepts loopback HTTP, IPv6 loopback HTTP, HTTPS, and mounted paths", async () => {
    const port = closedUrl.split(":")[2]?.split("/")[0] ?? "";
    for (const url of [
      `http://127.0.0.1:${port}/mcp`,
      `http://[::1]:${port}/mcp`,
      `https://127.0.0.1:${port}/mcp`,
      `https://127.0.0.1:${port}/e/orders-v2/mcp`,
      `https://127.0.0.1:${port}/${"a".repeat(251)}/mcp`,
    ]) {
      const result = await run(["--url", url]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toEqual([]);
    }
  });
});

describe("runProbe flag rules", () => {
  it.each([
    ["no arguments", []],
    ["a missing URL value", ["--url"]],
    ["an equals-joined URL", ["--url=http://127.0.0.1:1/mcp"]],
    ["a repeated URL", ["--url", "http://127.0.0.1:1/mcp", "--url", "x"]],
    ["a positional argument", ["--url", "http://127.0.0.1:1/mcp", "extra"]],
    ["an unknown flag", ["--url", "http://127.0.0.1:1/mcp", "--verbose"]],
    ["a short flag", ["--url", "http://127.0.0.1:1/mcp", "-u"]],
    ["an empty flag", ["--url", "http://127.0.0.1:1/mcp", ""]],
    ["a missing expectation", ["--url", "http://127.0.0.1:1/mcp", "--expect"]],
    [
      "an unknown expectation",
      ["--url", "http://127.0.0.1:1/mcp", "--expect", "healthy"],
    ],
    [
      "a miscased expectation",
      ["--url", "http://127.0.0.1:1/mcp", "--expect", "ALIVE"],
    ],
    [
      "a repeated expectation",
      [
        "--url",
        "http://127.0.0.1:1/mcp",
        "--expect",
        "alive",
        "--expect",
        "ready",
      ],
    ],
    [
      "a missing host header",
      ["--url", "http://127.0.0.1:1/mcp", "--host-header"],
    ],
    [
      "an empty host header",
      ["--url", "http://127.0.0.1:1/mcp", "--host-header", ""],
    ],
    [
      "a host header with a space",
      ["--url", "http://127.0.0.1:1/mcp", "--host-header", "engine example"],
    ],
    [
      "a host header with a line break",
      ["--url", "http://127.0.0.1:1/mcp", "--host-header", "engine\nexample"],
    ],
    [
      "a repeated host header",
      [
        "--url",
        "http://127.0.0.1:1/mcp",
        "--host-header",
        "a.example",
        "--host-header",
        "b.example",
      ],
    ],
  ])("rejects %s", async (_label, args) => {
    await expectUsageRejection(args);
  });
});

describe("runProbe timeout bounds", () => {
  it.each([
    ["a missing value", []],
    ["zero", ["0"]],
    ["one above the maximum", ["60001"]],
    ["a negative value", ["-1"]],
    ["a signed value", ["+1"]],
    ["a fractional value", ["3.5"]],
    ["exponent notation", ["1e3"]],
    ["a non-number", ["abc"]],
    ["an empty value", [""]],
    ["surrounding whitespace", [" 5 "]],
    ["hexadecimal notation", ["0x10"]],
    ["an oversized value", ["999999999999999999999"]],
    ["Infinity", ["Infinity"]],
    ["a repeated flag", ["1", "--timeout-ms", "2"]],
  ])("rejects %s", async (_label, tail) => {
    await expectUsageRejection([
      "--url",
      "http://127.0.0.1:1/mcp",
      "--timeout-ms",
      ...tail,
    ]);
  });

  it.each([["1"], ["3000"], ["60000"]])(
    "accepts the in-range timeout %s",
    async (value) => {
      const result = await run(["--url", closedUrl, "--timeout-ms", value]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toEqual([]);
    },
  );
});

describe("runProbe bearer rules", () => {
  it("rejects a bearer variable with the default alive expectation", async () => {
    await expectUsageRejection(
      ["--url", closedUrl, "--bearer-env", "PROBE_TOKEN"],
      { PROBE_TOKEN: secret },
    );
  });

  it("rejects a bearer variable with an explicit alive expectation", async () => {
    await expectUsageRejection(
      ["--url", closedUrl, "--expect", "alive", "--bearer-env", "PROBE_TOKEN"],
      { PROBE_TOKEN: secret },
    );
  });

  it.each([
    ["a missing value", [], {}],
    ["a lowercase name", ["probe_token"], { probe_token: secret }],
    ["a leading digit", ["9TOKEN"], { "9TOKEN": secret }],
    ["a hyphenated name", ["PROBE-TOKEN"], { "PROBE-TOKEN": secret }],
    ["an empty name", [""], {}],
    ["an unset variable", ["PROBE_TOKEN"], {}],
    ["an empty variable", ["PROBE_TOKEN"], { PROBE_TOKEN: "" }],
    [
      "a variable holding a line break",
      ["PROBE_TOKEN"],
      { PROBE_TOKEN: `abc\n${secret}` },
    ],
    [
      "a variable holding a space",
      ["PROBE_TOKEN"],
      { PROBE_TOKEN: `abc ${secret}` },
    ],
    [
      "a variable holding a non-ASCII character",
      ["PROBE_TOKEN"],
      { PROBE_TOKEN: `abcé${secret}` },
    ],
    [
      "a repeated flag",
      ["PROBE_TOKEN", "--bearer-env", "OTHER_TOKEN"],
      { PROBE_TOKEN: secret, OTHER_TOKEN: secret },
    ],
  ])("rejects %s", async (_label, tail, env) => {
    await expectUsageRejection(
      [
        "--url",
        "http://127.0.0.1:1/mcp",
        "--expect",
        "ready",
        "--bearer-env",
        ...tail,
      ],
      env,
    );
  });

  it("accepts a ready probe carrying a bearer variable", async () => {
    const result = await run(
      ["--url", closedUrl, "--expect", "ready", "--bearer-env", "PROBE_TOKEN"],
      { PROBE_TOKEN: secret },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
  });
});

describe("runProbe usage hygiene", () => {
  it("never echoes a rejected argument", async () => {
    const result = await run([
      "--url",
      `https://engine.example/mcp?token=${secret}`,
      `--${secret}`,
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("")).not.toContain(secret);
  });

  it("never echoes a rejected environment value", async () => {
    const result = await run(
      ["--url", closedUrl, "--expect", "ready", "--bearer-env", "PROBE_TOKEN"],
      { PROBE_TOKEN: `broken\r${secret}` },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("")).not.toContain(secret);
  });
});
