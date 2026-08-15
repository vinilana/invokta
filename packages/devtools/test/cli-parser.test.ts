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

describe("invokta-devtools open workbench selection", () => {
  it("parses --cli and --mcp as the workbench to land on", () => {
    expect(parseDevtoolsCommand(["open", "--cli"])).toEqual({
      command: "open",
      workbench: "cli",
    });
    expect(parseDevtoolsCommand(["--cli"])).toEqual({
      command: "open",
      workbench: "cli",
    });
    expect(parseDevtoolsCommand(["open", "--mcp"])).toEqual({
      command: "open",
      workbench: "mcp",
    });
    expect(parseDevtoolsCommand(["--mcp"])).toEqual({
      command: "open",
      workbench: "mcp",
    });
  });

  it("accepts a workbench with one loopback port in either form", () => {
    expect(parseDevtoolsCommand(["open", "--cli", "--port", "4200"])).toEqual({
      command: "open",
      workbench: "cli",
      port: 4200,
    });
    expect(parseDevtoolsCommand(["--cli", "--port", "4200"])).toEqual({
      command: "open",
      workbench: "cli",
      port: 4200,
    });
    expect(parseDevtoolsCommand(["open", "--port", "4200", "--mcp"])).toEqual({
      command: "open",
      workbench: "mcp",
      port: 4200,
    });
  });

  it("keeps bare and open without a workbench on the chooser", () => {
    expect(parseDevtoolsCommand([])).toEqual({ command: "open" });
    expect(parseDevtoolsCommand(["open"])).toEqual({ command: "open" });
    expect(parseDevtoolsCommand(["open", "--port", "4200"])).toEqual({
      command: "open",
      port: 4200,
    });
    expect(parseDevtoolsCommand(["--port", "4200"])).toEqual({
      command: "open",
      port: 4200,
    });
  });

  it.each([
    [["open", "--cli", "extra"], "does not accept positional arguments"],
    [["open", "--cli", "--cli"], "at most once"],
    [["--cli", "--cli"], "at most once"],
    [["open", "--mcp", "--mcp"], "at most once"],
    [["open", "--cli", "--mcp"], "select one workbench each"],
    [["--mcp", "--cli"], "select one workbench each"],
    [["open", "--cli", "--unknown"], 'Unknown option "--unknown"'],
    [["open", "--cli", "--port", "0"], "between 1 and 65535"],
    [["verify", "--cli"], 'Unknown option "--cli"'],
    [["verify", "--mcp"], 'Unknown option "--mcp"'],
  ] as const)(
    "rejects invalid open workbench arguments %#",
    (argv, message) => {
      expect(() => parseDevtoolsCommand(argv)).toThrow(message);
    },
  );

  it("does not parse verify --cli as a CLI verify target", () => {
    expect(() => parseDevtoolsCommand(["verify", "--cli"])).toThrow(
      'Unknown option "--cli"',
    );
    const verify = parseDevtoolsCommand(["verify", "--stdio", "node"]) as {
      readonly command: string;
      readonly target?: { readonly transport?: string };
    };
    expect(verify.command).toBe("verify");
    expect(verify.target?.transport).toBe("stdio");
    expect(verify).not.toMatchObject({ target: { transport: "cli" } });
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
      "invokta-devtools verify: INVALID_TARGET: The --arg, --cwd, and --env options are valid only with --stdio.\n",
    ]);
    expect(stderr.join("")).not.toContain("target-url-canary");
  });

  it("names the absent environment value in the exit 2 diagnostic", async () => {
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
        `invokta-devtools verify: ENVIRONMENT_VALUE_MISSING: "${sourceName}" is not set.\n`,
      ]);
      expect(stderr.join("")).not.toContain("descriptor-command-canary");
    } finally {
      if (previous === undefined) delete process.env[sourceName];
      else process.env[sourceName] = previous;
    }
  });
});

describe("invokta-devtools help and version", () => {
  it("parses --help/-h and --version/-v as dedicated commands", () => {
    expect(parseDevtoolsCommand(["--help"])).toEqual({ command: "help" });
    expect(parseDevtoolsCommand(["-h"])).toEqual({ command: "help" });
    expect(parseDevtoolsCommand(["--version"])).toEqual({
      command: "version",
    });
    expect(parseDevtoolsCommand(["-v"])).toEqual({ command: "version" });
  });

  it("prints the usage to stdout and exits 0 for --help", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runDevtoolsCli({
      argv: ["--help"],
      io: {
        writeStdout: (text) => {
          stdout.push(text);
        },
        writeStderr: (text) => {
          stderr.push(text);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toContain("Usage:");
    expect(stdout.join("")).toContain("invokta-devtools verify");
  });

  it("prints the package version to stdout and exits 0 for --version", async () => {
    const stdout: string[] = [];
    const exitCode = await runDevtoolsCli({
      argv: ["--version"],
      io: {
        writeStdout: (text) => {
          stdout.push(text);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toMatch(/^invokta-devtools \d+\.\d+\.\d+\n$/);
  });
});

describe("invokta-devtools verify limit and format flags", () => {
  it("parses --timeout-ms, --max-tools, and --json for both transports", () => {
    expect(
      parseDevtoolsCommand([
        "verify",
        "--stdio",
        "node",
        "--timeout-ms",
        "5000",
        "--max-tools",
        "25",
        "--json",
      ]),
    ).toEqual({
      command: "verify",
      timeoutMs: 5000,
      maxTools: 25,
      json: true,
      target: {
        transport: "stdio",
        command: "node",
        args: [],
        environment: [],
      },
    });
    expect(
      parseDevtoolsCommand([
        "verify",
        "--http",
        "https://example.com/mcp",
        "--timeout-ms",
        "2500",
        "--max-tools",
        "10",
        "--json",
      ]),
    ).toEqual({
      command: "verify",
      timeoutMs: 2500,
      maxTools: 10,
      json: true,
      target: {
        transport: "http",
        url: "https://example.com/mcp",
        authentication: { type: "none" },
      },
    });
  });

  it.each([
    [["verify", "--stdio", "node", "--timeout-ms", "0"], "positive integer"],
    [["verify", "--stdio", "node", "--timeout-ms", "1.5"], "positive integer"],
    [["verify", "--stdio", "node", "--max-tools", "many"], "positive integer"],
    [
      ["verify", "--stdio", "node", "--max-tools", "1", "--max-tools", "2"],
      "at most once",
    ],
    [
      ["verify", "--stdio", "node", "--timeout-ms", "1", "--timeout-ms", "2"],
      "at most once",
    ],
    [["verify", "--stdio", "node", "--json", "--json"], "at most once"],
  ] as const)("rejects invalid limit flags %#", (argv, message) => {
    expect(() => parseDevtoolsCommand(argv)).toThrow(message);
  });
});

describe("invokta-devtools doctor --json parsing", () => {
  it("parses --json as an additive doctor flag", () => {
    expect(
      parseDevtoolsCommand(["doctor", "./dist/engine.js", "--json"]),
    ).toEqual({
      command: "doctor",
      moduleSpecifier: "./dist/engine.js",
      exportName: "engine",
      json: true,
    });
    expect(parseDevtoolsCommand(["doctor", "./dist/engine.js"])).toEqual({
      command: "doctor",
      moduleSpecifier: "./dist/engine.js",
      exportName: "engine",
    });
  });

  it("rejects a repeated --json", () => {
    expect(() =>
      parseDevtoolsCommand(["doctor", "./dist/engine.js", "--json", "--json"]),
    ).toThrow("at most once");
  });
});

describe("invokta-devtools serve watch and trace flags", () => {
  it("parses repeatable watch filters and the trace capacity", () => {
    expect(
      parseDevtoolsCommand([
        "serve",
        "./dist/engine.js",
        "--watch",
        "--build",
        "yarn build",
        "--watch-include",
        "src",
        "--watch-include",
        "shared",
        "--watch-ignore",
        "*.test.ts",
        "--trace-capacity",
        "50",
      ]),
    ).toEqual({
      command: "serve",
      moduleSpecifier: "./dist/engine.js",
      exportName: "engine",
      buildCommand: "yarn build",
      watchInclude: ["src", "shared"],
      watchIgnore: ["*.test.ts"],
      traceCapacity: 50,
    });
  });

  it.each([
    [
      ["serve", "./dist/engine.js", "--watch-include", "src"],
      "require --watch",
    ],
    [
      [
        "serve",
        "./dist/engine.js",
        "--watch",
        "--build",
        "yarn build",
        "--watch-ignore",
      ],
      "requires a value",
    ],
    [
      ["serve", "./dist/engine.js", "--trace-capacity", "0"],
      "positive integer",
    ],
    [
      [
        "serve",
        "./dist/engine.js",
        "--trace-capacity",
        "1",
        "--trace-capacity",
        "2",
      ],
      "at most once",
    ],
  ] as const)("rejects invalid serve flags %#", (argv, message) => {
    expect(() => parseDevtoolsCommand(argv)).toThrow(message);
  });
});

describe("verify environment naming", () => {
  it("names the missing source value for stdio, bearer, and headers", () => {
    const stdio = parseDevtoolsCommand([
      "verify",
      "--stdio",
      "node",
      "--env",
      "CHILD=STDIO_SOURCE",
    ]);
    const bearer = parseDevtoolsCommand([
      "verify",
      "--http",
      "https://example.com/mcp",
      "--auth",
      "bearer",
      "--bearer-env",
      "BEARER_SOURCE",
    ]);
    const headers = parseDevtoolsCommand([
      "verify",
      "--http",
      "https://example.com/mcp",
      "--auth",
      "headers",
      "--header-env",
      "X-Key=HEADER_SOURCE",
    ]);

    expect(() =>
      resolveVerifyTargetEnvironment(stdio, () => undefined),
    ).toThrow('ENVIRONMENT_VALUE_MISSING: "STDIO_SOURCE" is not set.');
    expect(() =>
      resolveVerifyTargetEnvironment(bearer, () => undefined),
    ).toThrow('ENVIRONMENT_VALUE_MISSING: "BEARER_SOURCE" is not set.');
    expect(() =>
      resolveVerifyTargetEnvironment(headers, () => undefined),
    ).toThrow('ENVIRONMENT_VALUE_MISSING: "HEADER_SOURCE" is not set.');
  });
});
