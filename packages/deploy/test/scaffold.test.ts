import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HttpDeployManifest } from "../src/manifest.js";
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
  removeScaffoldProject,
  runCompiledModule,
  type ScaffoldProject,
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

const implementedAuthModule = `import type { McpHttpAuthOptions } from "@ai-engine/mcp";

export const httpAuth: McpHttpAuthOptions = {
  mode: "required",
  authenticate() {
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

interface RunningProcess {
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Starts the compiled composition root, waits for its announcement, then stops it. */
async function startThenTerminate(
  project: ScaffoldProject,
): Promise<RunningProcess> {
  const child = spawn(process.execPath, ["dist/mcp-http.js"], {
    cwd: project.directory,
    env: { PATH: process.env.PATH ?? "" },
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The composition root did not announce.")),
        20_000,
      );
      const settle = (error?: Error): void => {
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.includes("MCP endpoint:")) settle();
      });
      child.once("exit", () => {
        settle(new Error(`The composition root exited: ${stderr}`));
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.kill("SIGTERM");
  });
  return { stderr, exitCode };
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
      `${requiredName}=fixture-token\nAI_ENGINE_HTTP_PORT=0\n`,
      "utf8",
    );

    const result = await startThenTerminate(implemented);

    expect(result.stderr).toMatch(
      /MCP endpoint: http:\/\/127\.0\.0\.1:\d+\/mcp/,
    );
    expect(result.stderr).not.toContain("fixture-token");
    expect(result.exitCode).toBe(0);
  }, 30_000);
});

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
