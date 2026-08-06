import { describe, expect, it, vi } from "vitest";

import {
  parseDevtoolsCommand,
  resolveVerifyTargetEnvironment,
  runDevtoolsCli,
} from "../src/run-devtools-cli.js";

describe("invokta-devtools idle workbench parsing", () => {
  it("parses bare invocation and open as the same idle command", () => {
    expect(parseDevtoolsCommand([])).toEqual({ command: "open" });
    expect(parseDevtoolsCommand(["open"])).toEqual({ command: "open" });
  });

  it("accepts one loopback interface port in either form", () => {
    expect(parseDevtoolsCommand(["--port", "4200"])).toEqual({
      command: "open",
      port: 4200,
    });
    expect(parseDevtoolsCommand(["open", "--port", "4200"])).toEqual({
      command: "open",
      port: 4200,
    });
  });

  it.each([
    [["open", "extra"], "does not accept positional arguments"],
    [["open", "--port", "1", "--port", "2"], "at most once"],
    [["open", "--port", "0"], "between 1 and 65535"],
    [["--unknown"], 'Unknown option "--unknown"'],
  ] as const)("rejects invalid open arguments %#", (argv, message) => {
    expect(() => parseDevtoolsCommand(argv)).toThrow(message);
  });
});

describe("invokta-devtools verify stdio parsing", () => {
  it("preserves an exact structured stdio descriptor", () => {
    expect(
      parseDevtoolsCommand([
        "verify",
        "--stdio",
        "node",
        "--arg",
        "",
        "--arg",
        "--inspect=false",
        "--cwd",
        "./fixture dir",
        "--env",
        "API_TOKEN=SOURCE_TOKEN",
        "--env",
        "MODE=SOURCE_MODE",
      ]),
    ).toEqual({
      command: "verify",
      target: {
        transport: "stdio",
        command: "node",
        args: ["", "--inspect=false"],
        cwd: "./fixture dir",
        environment: [
          { childName: "API_TOKEN", sourceName: "SOURCE_TOKEN" },
          { childName: "MODE", sourceName: "SOURCE_MODE" },
        ],
      },
    });
  });

  it.each([
    [["verify"], "exactly one"],
    [
      ["verify", "--stdio", "node", "--http", "https://example.com/mcp"],
      "exactly one",
    ],
    [["verify", "--stdio", "node", "--stdio", "other"], "at most once"],
    [
      ["verify", "--stdio", "node", "extra"],
      "does not accept positional arguments",
    ],
    [["verify", "--stdio", "node", "--env", "INVALID"], "CHILD=SOURCE"],
    [
      ["verify", "--stdio", "node", "--env", "1BAD=SOURCE"],
      "valid environment variable names",
    ],
    [
      ["verify", "--stdio", "node", "--env", "A=ONE", "--env", "A=TWO"],
      "child name at most once",
    ],
    [["verify", "--stdio", "node", "--auth", "none"], "only with --http"],
  ] as const)("rejects invalid stdio arguments %#", (argv, message) => {
    expect(() => parseDevtoolsCommand(argv)).toThrow(message);
  });
});

describe("invokta-devtools verify HTTP parsing", () => {
  it("defaults to no authentication", () => {
    expect(
      parseDevtoolsCommand(["verify", "--http", "https://example.com/mcp"]),
    ).toEqual({
      command: "verify",
      target: {
        transport: "http",
        url: "https://example.com/mcp",
        authentication: { type: "none" },
      },
    });
  });

  it("parses bearer and custom-header environment references", () => {
    expect(
      parseDevtoolsCommand([
        "verify",
        "--http",
        "https://example.com/mcp",
        "--auth",
        "bearer",
        "--bearer-env",
        "MCP_TOKEN",
      ]),
    ).toEqual({
      command: "verify",
      target: {
        transport: "http",
        url: "https://example.com/mcp",
        authentication: { type: "bearer", sourceName: "MCP_TOKEN" },
      },
    });
    expect(
      parseDevtoolsCommand([
        "verify",
        "--http",
        "http://[::1]:3000/mcp",
        "--auth",
        "headers",
        "--header-env",
        "X-Api-Key=PRIMARY_KEY",
        "--header-env",
        "Authorization=CUSTOM_AUTH",
      ]),
    ).toEqual({
      command: "verify",
      target: {
        transport: "http",
        url: "http://[::1]:3000/mcp",
        authentication: {
          type: "headers",
          headers: [
            { headerName: "X-Api-Key", sourceName: "PRIMARY_KEY" },
            { headerName: "Authorization", sourceName: "CUSTOM_AUTH" },
          ],
        },
      },
    });
  });

  it.each([
    [["verify", "--http", "http://localhost/mcp"], "requires HTTPS"],
    [
      ["verify", "--http", "https://user@example.com/mcp"],
      "must not contain credentials",
    ],
    [
      ["verify", "--http", "https://example.com/mcp?"],
      "must not contain a query",
    ],
    [
      ["verify", "--http", "https://example.com/mcp#fragment"],
      "must not contain a fragment",
    ],
    [
      ["verify", "--http", "https://example.com:/mcp"],
      "canonical absolute HTTP URL",
    ],
    [
      ["verify", "--http", "https://example.com/mcp", "--auth", "bearer"],
      "requires --bearer-env",
    ],
    [
      ["verify", "--http", "https://example.com/mcp", "--auth", "oauth"],
      "must be none, bearer, or headers",
    ],
    [
      [
        "verify",
        "--http",
        "https://example.com/mcp",
        "--auth",
        "none",
        "--bearer-env",
        "TOKEN",
      ],
      "forbids --bearer-env",
    ],
    [
      ["verify", "--http", "https://example.com/mcp", "--auth", "headers"],
      "requires at least one --header-env",
    ],
    [
      [
        "verify",
        "--http",
        "https://example.com/mcp",
        "--auth",
        "headers",
        "--header-env",
        "X-Key=ONE",
        "--header-env",
        "x-key=TWO",
      ],
      "case-insensitively unique",
    ],
    [
      [
        "verify",
        "--http",
        "https://example.com/mcp",
        "--auth",
        "headers",
        "--header-env",
        "Host=HOST_VALUE",
      ],
      "transport-owned",
    ],
    [
      [
        "verify",
        "--http",
        "https://example.com/mcp",
        "--auth",
        "headers",
        "--header-env",
        "Accept=ACCEPT_VALUE",
      ],
      "transport-owned",
    ],
    [
      [
        "verify",
        "--http",
        "https://example.com/mcp",
        "--bearer",
        "literal-credential-canary",
      ],
      'Unknown option "--bearer"',
    ],
    [
      ["verify", "--http", "https://example.com/mcp", "--arg", "value"],
      "only with --stdio",
    ],
  ] as const)("rejects invalid HTTP arguments %#", (argv, message) => {
    expect(() => parseDevtoolsCommand(argv)).toThrow(message);
  });
});

describe("verify environment resolution", () => {
  it("does not inspect environment values until every argument validates", () => {
    const read = vi.fn<(name: string) => string | undefined>(() => "secret");

    expect(() =>
      parseDevtoolsCommand([
        "verify",
        "--http",
        "https://example.com/mcp",
        "--auth",
        "bearer",
        "--bearer-env",
        "TOKEN",
        "--arg",
        "invalid-for-http",
      ]),
    ).toThrow("only with --stdio");
    expect(read).not.toHaveBeenCalled();
  });

  it("resolves stdio overlays and HTTP credentials only from named values", () => {
    const stdio = parseDevtoolsCommand([
      "verify",
      "--stdio",
      "node",
      "--env",
      "CHILD_TOKEN=SOURCE_TOKEN",
    ]);
    const http = parseDevtoolsCommand([
      "verify",
      "--http",
      "https://example.com/mcp",
      "--auth",
      "headers",
      "--header-env",
      "X-Key=SOURCE_HEADER",
    ]);
    const read = vi.fn((name: string) =>
      name === "SOURCE_TOKEN" ? "stdio-secret" : "header-secret",
    );

    expect(resolveVerifyTargetEnvironment(stdio, read)).toEqual({
      transport: "stdio",
      command: "node",
      args: [],
      env: { CHILD_TOKEN: "stdio-secret" },
    });
    expect(resolveVerifyTargetEnvironment(http, read)).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      authentication: {
        type: "headers",
        headers: { "X-Key": "header-secret" },
      },
    });
    expect(read.mock.calls).toEqual([["SOURCE_TOKEN"], ["SOURCE_HEADER"]]);
  });

  it("rejects absent, empty, newline, and padded bearer values safely", () => {
    const stdio = parseDevtoolsCommand([
      "verify",
      "--stdio",
      "node",
      "--env",
      "TOKEN=SOURCE",
    ]);
    const headers = parseDevtoolsCommand([
      "verify",
      "--http",
      "https://example.com/mcp",
      "--auth",
      "headers",
      "--header-env",
      "X-Key=SOURCE",
    ]);
    const bearer = parseDevtoolsCommand([
      "verify",
      "--http",
      "https://example.com/mcp",
      "--auth",
      "bearer",
      "--bearer-env",
      "SOURCE",
    ]);

    expect(() =>
      resolveVerifyTargetEnvironment(stdio, () => undefined),
    ).toThrow("ENVIRONMENT_VALUE_MISSING");
    expect(() => resolveVerifyTargetEnvironment(stdio, () => "")).toThrow(
      "ENVIRONMENT_VALUE_MISSING",
    );
    expect(() =>
      resolveVerifyTargetEnvironment(headers, () => "bad\nvalue"),
    ).toThrow("INVALID_TARGET");
    expect(() =>
      resolveVerifyTargetEnvironment(bearer, () => " token "),
    ).toThrow("INVALID_TARGET");
  });

  it("returns sanitized exit 2 diagnostics before target execution", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const invalidOptionsExit = await runDevtoolsCli({
      argv: [
        "verify",
        "--http",
        "https://target-url-canary.example/mcp",
        "--arg",
        "invalid-for-http",
      ],
      io: {
        writeStdout: (text) => {
          stdout.push(text);
        },
        writeStderr: (text) => {
          stderr.push(text);
        },
      },
    });

    expect(invalidOptionsExit).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "invokta-devtools verify: INVALID_TARGET: The verify command arguments are invalid.\n",
    ]);
    expect(stderr.join("")).not.toContain("target-url-canary");
  });

  it("returns a secret-free exit 2 when a named environment value is absent", async () => {
    const sourceName = "INVOKTA_TEST_MISSING_VERIFY_ENV_59B3B45D";
    const previous = process.env[sourceName];
    delete process.env[sourceName];
    const stderr: string[] = [];
    try {
      const exitCode = await runDevtoolsCli({
        argv: [
          "verify",
          "--stdio",
          "descriptor-command-canary",
          "--env",
          `CHILD_TOKEN=${sourceName}`,
        ],
        io: {
          writeStderr: (text) => {
            stderr.push(text);
          },
        },
      });

      expect(exitCode).toBe(2);
      expect(stderr).toEqual([
        "invokta-devtools verify: ENVIRONMENT_VALUE_MISSING: A required environment value is missing.\n",
      ]);
      expect(stderr.join("")).not.toContain(sourceName);
      expect(stderr.join("")).not.toContain("descriptor-command-canary");
    } finally {
      if (previous === undefined) delete process.env[sourceName];
      else process.env[sourceName] = previous;
    }
  });
});
