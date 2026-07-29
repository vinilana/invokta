import { rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { HttpDeployManifest } from "../src/manifest.js";
import { probeProtocolVersion } from "../src/probe-contract.js";
import {
  createScaffoldFiles,
  environmentModuleTemplate,
  httpAuthModuleTemplate,
  renderHttpRootModule,
  starterDeployManifest,
} from "../src/scaffold/index.js";
import {
  type CompileResult,
  checkScaffoldProject,
  compileScaffoldProject,
  createScaffoldProject,
  environmentOverrideLostStatus,
  removeScaffoldProject,
  reserveLoopbackPort,
  runCompiledModule,
  runCompiledModuleWithReplacedEnv,
  type ScaffoldProject,
  startCompiledModule,
  type StartedModule,
} from "./support/init-scaffold-project.js";

const requiredName = "SCAFFOLD_TEST_TOKEN";

const manifest: HttpDeployManifest = {
  ...starterDeployManifest,
  env: { required: [requiredName], optional: ["SCAFFOLD_TEST_OPTIONAL"] },
};

const engineModule = `import { createEngine } from "@ai-engine/core";

export const engine = createEngine({
  name: "scaffold-fixture",
  version: "0.1.0",
  capabilities: {},
});
`;

// The delay is what makes a request observably in flight: the hook announces
// that the adapter has handed it a request and then holds it, so a signal can
// arrive while the exchange is open. Without the variable the hook answers
// immediately, exactly as an implemented one would.
const implementedAuthModule = `import type { McpHttpAuthOptions } from "@ai-engine/mcp";

const holdMs = Number(process.env.SCAFFOLD_TEST_AUTH_HOLD_MS ?? "0");

export const httpAuth: McpHttpAuthOptions = {
  mode: "required",
  async authenticate() {
    if (holdMs > 0) {
      process.stderr.write("auth-hook: holding\\n");
      await new Promise((resolve) => {
        setTimeout(resolve, holdMs);
      });
    }
    return { id: "scaffold-fixture" };
  },
};
`;

function sources(): Record<string, string> {
  const files: Record<string, string> = { "src/engine.ts": engineModule };
  for (const file of createScaffoldFiles(manifest)) {
    if (file.path.startsWith("src/")) files[file.path] = file.contents;
  }
  return files;
}

let scaffolded: ScaffoldProject;
let implemented: ScaffoldProject;
let scaffoldedCompilation: CompileResult;

beforeAll(() => {
  scaffolded = createScaffoldProject(sources());
  implemented = createScaffoldProject({
    ...sources(),
    "src/http-auth.ts": implementedAuthModule,
  });
  scaffoldedCompilation = compileScaffoldProject(scaffolded);
}, 120_000);

afterAll(() => {
  removeScaffoldProject(scaffolded);
  removeScaffoldProject(implemented);
});

const token = "fixture-token";

/** The environment every started fixture needs, and nothing else. */
function baseEnvironment(): Record<string, string> {
  return { [requiredName]: token };
}

function start(
  environment: Readonly<Record<string, string>>,
): Promise<StartedModule> {
  return startCompiledModule(implemented, "dist/mcp-http.js", {
    ...baseEnvironment(),
    ...environment,
  });
}

interface Exchange {
  readonly outcome: "response" | "aborted";
  /** The HTTP status, or the transport error code when the socket closed. */
  readonly detail: string;
}

interface ExchangeOptions {
  readonly hostHeader?: string;
  readonly bearer?: string;
  readonly padding?: number;
}

/**
 * Sends one MCP `initialize` over a private connection and reports whether the
 * endpoint answered or the connection was closed under it.
 */
function postInitialize(
  port: number,
  options: ExchangeOptions = {},
): Promise<Exchange> {
  const message: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: probeProtocolVersion,
      capabilities: {},
      clientInfo: { name: "scaffold-test", version: "0" },
      ...(options.padding === undefined
        ? {}
        : { padding: "x".repeat(options.padding) }),
    },
  };
  const body = JSON.stringify(message);
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    host: options.hostHeader ?? `127.0.0.1:${String(port)}`,
  };
  if (options.bearer !== undefined) {
    headers.authorization = `Bearer ${options.bearer}`;
  }

  return new Promise<Exchange>((resolve) => {
    const clientRequest = httpRequest(
      {
        agent: false,
        headers,
        host: "127.0.0.1",
        method: "POST",
        path: "/mcp",
        port,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve({
            outcome: "response",
            detail: String(response.statusCode ?? 0),
          });
        });
        response.once("error", () => {
          resolve({ outcome: "aborted", detail: "response-error" });
        });
      },
    );
    clientRequest.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ outcome: "aborted", detail: error.code ?? error.message });
    });
    clientRequest.end(body);
  });
}

describe("the scaffolded sources", () => {
  it("type-check against the real workspace packages", () => {
    expect(scaffoldedCompilation.output).toBe("");
    expect(scaffoldedCompilation.status).toBe(0);
  });

  it("satisfy the formatter, the lint preset, and import organization", () => {
    const result = checkScaffoldProject(scaffolded);

    expect(result.output).toContain("Checked 4 files");
    expect(result.status).toBe(0);
  });

  it("refuse to start until the authentication hook is implemented", () => {
    const result = runCompiledModule(scaffolded, "dist/mcp-http.js");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Implement authentication before deploying",
    );
    expect(result.stderr).not.toContain("dangerously-disabled-for-development");
  });
});

describe("the scaffolded composition root", () => {
  beforeAll(() => {
    const result = compileScaffoldProject(implemented);
    expect(result.output).toBe("");
  }, 120_000);

  it("reports a missing required variable as one sanitized line", () => {
    rmSync(join(implemented.directory, ".env"), { force: true });

    const result = runCompiledModule(implemented, "dist/mcp-http.js");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `A required environment variable is missing. (${requiredName})\n`,
    );
  });

  it("reads its configuration from the environment file it loaded", () => {
    writeFileSync(
      join(implemented.directory, ".env"),
      `${requiredName}=fixture-token\nAI_ENGINE_HTTP_PORT=70000\n`,
      "utf8",
    );

    const result = runCompiledModule(implemented, "dist/mcp-http.js");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("AI_ENGINE_HTTP_PORT");
    expect(result.stderr).not.toContain("fixture-token");
  });

  it("lets the real environment win over the environment file", () => {
    writeFileSync(
      join(implemented.directory, ".env"),
      `${requiredName}=fixture-token\nAI_ENGINE_HTTP_PORT=70000\n`,
      "utf8",
    );

    const result = runCompiledModule(implemented, "dist/mcp-http.js", {
      AI_ENGINE_HTTP_PORT: "0",
      AI_ENGINE_HTTP_MAX_BODY_BYTES: "not-an-integer",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AI_ENGINE_HTTP_MAX_BODY_BYTES");
  });

  it("binds the port the environment file supplies and exits 0 on SIGTERM", async () => {
    writeFileSync(
      join(implemented.directory, ".env"),
      `${requiredName}=${token}\nAI_ENGINE_HTTP_PORT=0\n`,
      "utf8",
    );

    const started = await startCompiledModule(implemented, "dist/mcp-http.js");
    started.signal("SIGTERM");
    const exited = await started.exit();

    expect(started.stderr()).toMatch(
      /MCP endpoint: http:\/\/127\.0\.0\.1:\d+\/mcp/,
    );
    expect(started.stderr()).not.toContain(token);
    expect(exited.code).toBe(0);
  }, 30_000);
});

/**
 * The contract table of `AE-DEPLOY-ENV-01`, exercised by running the compiled
 * composition root once per case. Each row proves that the named variable
 * aborts startup rather than falling back to a default, and that the
 * diagnostic names the variable and carries no value.
 */
const invalidValueCases = [
  [
    "AI_ENGINE_HTTP_HOST",
    "an empty host",
    { AI_ENGINE_HTTP_HOST: "" },
    "AI_ENGINE_HTTP_HOST must not be empty.",
  ],
  [
    "AI_ENGINE_HTTP_HOST",
    "a non-loopback host with no allowlist",
    { AI_ENGINE_HTTP_HOST: "10.0.0.5" },
    "AI_ENGINE_HTTP_ALLOWED_HOSTS is required when AI_ENGINE_HTTP_HOST is not a loopback address.",
  ],
  [
    "AI_ENGINE_HTTP_PORT",
    "an empty port",
    { AI_ENGINE_HTTP_PORT: "" },
    "AI_ENGINE_HTTP_PORT must not be empty.",
  ],
  [
    "AI_ENGINE_HTTP_PORT",
    "a non-integer port",
    { AI_ENGINE_HTTP_PORT: "3000.5" },
    "AI_ENGINE_HTTP_PORT must be an integer between 0 and 65535.",
  ],
  [
    "AI_ENGINE_HTTP_PORT",
    "a port above the range",
    { AI_ENGINE_HTTP_PORT: "70000" },
    "AI_ENGINE_HTTP_PORT must be an integer between 0 and 65535.",
  ],
  [
    "AI_ENGINE_HTTP_PORT",
    "a negative port",
    { AI_ENGINE_HTTP_PORT: "-1" },
    "AI_ENGINE_HTTP_PORT must be an integer between 0 and 65535.",
  ],
  ["PORT", "an empty fallback port", { PORT: "" }, "PORT must not be empty."],
  [
    "PORT",
    "a fallback port above the range",
    { PORT: "70000" },
    "PORT must be an integer between 0 and 65535.",
  ],
  [
    "AI_ENGINE_HTTP_ALLOWED_HOSTS",
    "an empty host allowlist",
    { AI_ENGINE_HTTP_ALLOWED_HOSTS: "" },
    "AI_ENGINE_HTTP_ALLOWED_HOSTS must not be empty.",
  ],
  [
    "AI_ENGINE_HTTP_ALLOWED_HOSTS",
    "a host allowlist of separators only",
    { AI_ENGINE_HTTP_ALLOWED_HOSTS: " , , " },
    "AI_ENGINE_HTTP_ALLOWED_HOSTS must list at least one entry.",
  ],
  [
    "AI_ENGINE_HTTP_ALLOWED_ORIGINS",
    "an empty origin allowlist",
    { AI_ENGINE_HTTP_ALLOWED_ORIGINS: "" },
    "AI_ENGINE_HTTP_ALLOWED_ORIGINS must not be empty.",
  ],
  [
    "AI_ENGINE_HTTP_ALLOWED_ORIGINS",
    "an origin allowlist of separators only",
    { AI_ENGINE_HTTP_ALLOWED_ORIGINS: ",," },
    "AI_ENGINE_HTTP_ALLOWED_ORIGINS must list at least one entry.",
  ],
  [
    "AI_ENGINE_HTTP_MAX_BODY_BYTES",
    "an empty body limit",
    { AI_ENGINE_HTTP_MAX_BODY_BYTES: "" },
    "AI_ENGINE_HTTP_MAX_BODY_BYTES must not be empty.",
  ],
  [
    "AI_ENGINE_HTTP_MAX_BODY_BYTES",
    "a zero body limit",
    { AI_ENGINE_HTTP_MAX_BODY_BYTES: "0" },
    "AI_ENGINE_HTTP_MAX_BODY_BYTES must be an integer between 1 and 9007199254740991.",
  ],
  [
    "AI_ENGINE_HTTP_MAX_BODY_BYTES",
    "a fractional body limit",
    { AI_ENGINE_HTTP_MAX_BODY_BYTES: "1.5" },
    "AI_ENGINE_HTTP_MAX_BODY_BYTES must be an integer between 1 and 9007199254740991.",
  ],
] as const;

const nulCarryingVariables = [
  "AI_ENGINE_HTTP_HOST",
  "AI_ENGINE_HTTP_PORT",
  "PORT",
  "AI_ENGINE_HTTP_ALLOWED_HOSTS",
  "AI_ENGINE_HTTP_ALLOWED_ORIGINS",
  "AI_ENGINE_HTTP_MAX_BODY_BYTES",
] as const;

describe("the environment contract of the scaffolded composition root", () => {
  beforeEach(() => {
    // No environment file, so every case reads exactly what it declares.
    rmSync(join(implemented.directory, ".env"), { force: true });
  });

  it.each(invalidValueCases)(
    "aborts startup for %s given %s",
    (variable, _label, environment, expected) => {
      const result = runCompiledModule(implemented, "dist/mcp-http.js", {
        ...baseEnvironment(),
        ...environment,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${expected}\n`);
      expect(result.stderr).toContain(variable);
      expect(result.stderr).not.toContain(token);
    },
  );

  // A POSIX environment block is NUL-terminated, so a NUL reaches the
  // composition root only through an environment object the harness supplies.
  // The harness refuses to continue when the value did not survive, so this
  // case cannot degrade into a run that never carried a NUL at all.
  it.each(nulCarryingVariables)(
    "aborts startup for a NUL in %s",
    (variable) => {
      const result = runCompiledModuleWithReplacedEnv(
        implemented,
        "dist/mcp-http.js",
        { [variable]: "a\u0000b" },
        baseEnvironment(),
      );

      expect(result.status).not.toBe(environmentOverrideLostStatus);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `${variable} must not contain a NUL character.\n`,
      );
    },
  );

  it("binds the port AI_ENGINE_HTTP_PORT names when PORT is also set", async () => {
    const fallbackPort = await reserveLoopbackPort();
    const preferredPort = await reserveLoopbackPort();
    const started = await start({
      AI_ENGINE_HTTP_HOST: "localhost",
      PORT: String(fallbackPort),
      AI_ENGINE_HTTP_PORT: String(preferredPort),
    });

    try {
      // The announced port is the port the listener really bound, so this is
      // the precedence rule observed rather than the source text inspected.
      expect(started.port).toBe(preferredPort);
      expect(started.port).not.toBe(fallbackPort);
      expect(started.host).toBe("localhost");
      expect(started.stderr()).not.toContain(token);
    } finally {
      started.signal("SIGTERM");
      const exited = await started.exit();
      expect(exited.code).toBe(0);
    }
  }, 30_000);

  it("falls back to PORT when AI_ENGINE_HTTP_PORT is absent", async () => {
    const fallbackPort = await reserveLoopbackPort();
    const started = await start({ PORT: String(fallbackPort) });

    try {
      expect(started.port).toBe(fallbackPort);
    } finally {
      started.signal("SIGTERM");
      expect((await started.exit()).code).toBe(0);
    }
  }, 30_000);

  it("passes the allowlist and the body limit through to the adapter", async () => {
    const started = await start({
      AI_ENGINE_HTTP_PORT: "0",
      AI_ENGINE_HTTP_ALLOWED_HOSTS: "engine.example, engine.example:443",
      AI_ENGINE_HTTP_ALLOWED_ORIGINS: "https://app.example",
      AI_ENGINE_HTTP_MAX_BODY_BYTES: "256",
    });

    try {
      // A Host outside the allowlist is refused, which only happens when the
      // parsed list reached serveMcpHttp.
      const refused = await postInitialize(started.port);
      expect(refused).toEqual({ outcome: "response", detail: "403" });

      // An allowed Host reaches the engine and is served.
      const served = await postInitialize(started.port, {
        hostHeader: "engine.example",
      });
      expect(served).toEqual({ outcome: "response", detail: "200" });

      // And the declared limit is the limit the adapter enforces.
      const oversize = await postInitialize(started.port, {
        hostHeader: "engine.example",
        padding: 512,
      });
      expect(oversize).toEqual({ outcome: "response", detail: "413" });
    } finally {
      started.signal("SIGTERM");
      expect((await started.exit()).code).toBe(0);
    }
  }, 30_000);
});

describe.each(["SIGTERM", "SIGINT"] as const)(
  "the scaffolded composition root on %s",
  (signalName) => {
    beforeEach(() => {
      rmSync(join(implemented.directory, ".env"), { force: true });
    });

    it("aborts the request it is holding and exits 0", async () => {
      const started = await start({
        AI_ENGINE_HTTP_PORT: "0",
        // Far longer than the test's own deadline: if the shutdown did not
        // abort the exchange, this test would time out rather than pass.
        SCAFFOLD_TEST_AUTH_HOLD_MS: "60000",
      });

      try {
        const inFlight = postInitialize(started.port, { bearer: token });
        await started.waitForStderr("auth-hook: holding");

        started.signal(signalName);
        const exchange = await inFlight;
        const exited = await started.exit();

        expect(exchange.outcome).toBe("aborted");
        expect(exited.code).toBe(0);
        expect(exited.signal).toBeNull();
        expect(started.stderr()).not.toContain(token);
      } finally {
        started.kill();
      }
    }, 45_000);

    it("exits 0 with nothing in flight", async () => {
      const started = await start({ AI_ENGINE_HTTP_PORT: "0" });

      started.signal(signalName);
      const exited = await started.exit();

      expect(exited.code).toBe(0);
      expect(exited.signal).toBeNull();
    }, 30_000);
  },
);

describe("the scaffold templates", () => {
  const templates = {
    "src/env.ts": environmentModuleTemplate,
    "src/http-auth.ts": httpAuthModuleTemplate,
    "src/mcp-http.ts": renderHttpRootModule(manifest),
  } as const;

  it("emit UTF-8 text with LF endings and one trailing newline", () => {
    for (const contents of Object.values(templates)) {
      expect(contents).not.toContain("\r");
      expect(contents).not.toContain("\u0000");
      expect(contents.endsWith("\n")).toBe(true);
      expect(contents.endsWith("\n\n")).toBe(false);
    }
  });

  it("never mention the development authentication opt-out", () => {
    for (const contents of Object.values(templates)) {
      expect(contents).not.toContain("dangerously");
    }
  });

  it("keep the loader on Node built-ins only", () => {
    const specifiers = [
      ...environmentModuleTemplate.matchAll(/from "([^"]+)"/g),
    ].map((match) => match[1]);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier?.startsWith("node:")).toBe(true);
    }
    expect(environmentModuleTemplate).not.toContain("import(");
    expect(environmentModuleTemplate).not.toContain("require(");
  });

  it("load the environment file before anything else in the HTTP root", () => {
    const root = renderHttpRootModule(manifest);
    const firstImport = /^import .*$/m.exec(root)?.[0];

    expect(firstImport).toBe('import "./env.js";');
    expect(root.indexOf("./env.js")).toBeLessThan(
      root.indexOf("@ai-engine/mcp"),
    );
    expect(root.indexOf("requireEnvironment(")).toBeLessThan(
      root.indexOf('import("./engine.js")'),
    );
  });

  it("implement the documented environment contract", () => {
    const root = renderHttpRootModule(manifest);

    for (const name of [
      "AI_ENGINE_HTTP_HOST",
      "AI_ENGINE_HTTP_PORT",
      "PORT",
      "AI_ENGINE_HTTP_ALLOWED_HOSTS",
      "AI_ENGINE_HTTP_ALLOWED_ORIGINS",
      "AI_ENGINE_HTTP_MAX_BODY_BYTES",
    ]) {
      expect(root).toContain(name);
    }
    expect(root.indexOf("AI_ENGINE_HTTP_PORT")).toBeLessThan(
      root.indexOf('"PORT"'),
    );
    expect(root).toContain(`"${requiredName}"`);
    expect(root).toContain("serveMcpHttp");
    expect(root).toContain("SIGTERM");
    expect(root).toContain("SIGINT");
  });

  it("fail the authentication hook closed at module load", () => {
    expect(httpAuthModuleTemplate).toContain('mode: "required"');
    expect(httpAuthModuleTemplate).toContain(
      "Implement authentication before deploying",
    );
    expect(httpAuthModuleTemplate).toContain("throw new Error(");
  });
});
