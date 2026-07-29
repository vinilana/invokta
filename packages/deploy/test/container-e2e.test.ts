import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";
import { runPackage } from "../src/package-command.js";
import { probeProtocolVersion } from "../src/probe-contract.js";
import { writeProjectFile } from "./support/package-project.js";
import { createTestContext } from "./support/test-context.js";

const bearerVariable = "E2E_BEARER_TOKEN";
const bearerToken = "e2e-container-token-sentinel";
const imagePort = 3000;
const containerName = `invokta-deploy-e2e-${process.pid.toString(36)}`;
const imageTag = `${containerName}:test`;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function docker(
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): CommandResult {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return {
    status: result.error === undefined ? result.status : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? `${result.error?.message ?? ""}`,
  };
}

/**
 * A usable container runtime, not merely a `docker` on PATH: the WSL and
 * Docker Desktop shims answer to `--version` while no daemon is reachable.
 */
function detectContainerRuntime(): { available: boolean; reason: string } {
  const version = docker(["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: 30_000,
  });
  if (version.status !== 0) {
    const detail = `${version.stdout}${version.stderr}`.trim().split("\n")[0];
    return {
      available: false,
      reason: `no container runtime: ${detail === undefined || detail === "" ? "docker is not installed" : detail}`,
    };
  }
  return { available: true, reason: `docker server ${version.stdout.trim()}` };
}

const runtime = detectContainerRuntime();

// The runtime image needs one production dependency to copy, and this project
// must build without a registry, so the dependency is vendored in the context
// and referenced by path. Nothing imports it: it exists so that
// `npm ci --omit=dev` leaves a node_modules directory for the runtime stage.
const vendorName = "deploy-e2e-runtime";

const projectPackage = {
  name: "deploy-e2e-engine",
  version: "1.0.0",
  private: true,
  type: "module",
  scripts: { build: "node build.mjs" },
  dependencies: { [vendorName]: `file:vendor/${vendorName}` },
};

const projectLockfile = {
  name: projectPackage.name,
  version: projectPackage.version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: projectPackage.name,
      version: projectPackage.version,
      dependencies: projectPackage.dependencies,
    },
    [`node_modules/${vendorName}`]: {
      resolved: `vendor/${vendorName}`,
      link: true,
    },
    [`vendor/${vendorName}`]: { name: vendorName, version: "1.0.0" },
  },
};

const deployManifest = {
  schemaVersion: 1,
  entry: "dist/mcp-http.js",
  env: { required: [bearerVariable] },
  image: { port: imagePort },
  healthcheck: { expect: "ready", bearerEnv: bearerVariable },
};

const buildScript = `import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("server.mjs", "dist/mcp-http.js");
`;

/**
 * The engine under test. It answers the MCP `initialize` handshake over the
 * documented boundary with Node built-ins only, so the container context needs
 * no registry and no workspace linking — the first release does not support a
 * workspace build context, and what this test exercises is the generated
 * deployment package, not the adapter, which its own integration test covers.
 */
const serverModule = `import { createServer } from "node:http";

const host = process.env.INVOKTA_HTTP_HOST ?? "127.0.0.1";
const port = Number(
  process.env.INVOKTA_HTTP_PORT ?? process.env.PORT ?? "${imagePort}",
);
const token = process.env.${bearerVariable} ?? "";

if (token === "") {
  process.stderr.write("A required environment variable is missing.\\n");
  process.exit(1);
}

const server = createServer((incoming, response) => {
  if (incoming.method !== "POST" || (incoming.url ?? "") !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  incoming.on("data", (chunk) => chunks.push(chunk));
  incoming.on("end", () => {
    if ((incoming.headers.authorization ?? "") !== "Bearer " + token) {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "unauthorized" },
        }),
      );
      return;
    }
    let id = null;
    try {
      id = JSON.parse(Buffer.concat(chunks).toString("utf8")).id ?? null;
    } catch {
      id = null;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "${probeProtocolVersion}",
          capabilities: { tools: {} },
          serverInfo: { name: "deploy-e2e-engine", version: "1.0.0" },
        },
      }),
    );
  });
});

server.listen(port, host, () => {
  process.stderr.write("MCP endpoint: http://" + host + ":" + port + "/mcp\\n");
});

const shutdown = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
`;

function encode(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function createEngineProject(): string {
  const root = mkdtempSync(join(tmpdir(), "invokta-container-"));
  writeProjectFile(root, "package.json", encode(projectPackage));
  writeProjectFile(root, "package-lock.json", encode(projectLockfile));
  writeProjectFile(root, "invokta.deploy.json", encode(deployManifest));
  writeProjectFile(root, "build.mjs", buildScript);
  writeProjectFile(root, "server.mjs", serverModule);
  writeProjectFile(
    root,
    `vendor/${vendorName}/package.json`,
    encode({ name: vendorName, version: "1.0.0", type: "module" }),
  );
  writeProjectFile(
    root,
    `vendor/${vendorName}/index.js`,
    "export const marker = 'deploy-e2e';\n",
  );
  // `package` requires the entry as evidence that the project was built; the
  // image builds it again from the same script.
  writeProjectFile(root, "dist/mcp-http.js", serverModule);
  return root;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the reserved address is not a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Exchange {
  readonly status: number;
  readonly body: string;
  readonly challenge: string;
}

function postInitialize(port: number, bearer?: string): Promise<Exchange> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "container-e2e",
    method: "initialize",
    params: {
      protocolVersion: probeProtocolVersion,
      capabilities: {},
      clientInfo: { name: "container-e2e", version: "0" },
    },
  });
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;

  return new Promise<Exchange>((resolve, reject) => {
    const clientRequest = httpRequest(
      {
        agent: false,
        headers,
        host: "127.0.0.1",
        method: "POST",
        path: "/mcp",
        port,
        timeout: 10_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            challenge: String(response.headers["www-authenticate"] ?? ""),
          });
        });
      },
    );
    clientRequest.once("error", reject);
    clientRequest.once("timeout", () => {
      clientRequest.destroy(new Error("the request timed out"));
    });
    clientRequest.end(body);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls the container's own HEALTHCHECK verdict within a bounded deadline. */
async function waitForHealthy(deadlineMs: number): Promise<string> {
  const until = Date.now() + deadlineMs;
  let last = "unknown";
  while (Date.now() < until) {
    const inspected = docker([
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      containerName,
    ]);
    last = inspected.stdout.trim();
    if (last === "healthy" || last === "unhealthy") return last;
    await sleep(2_000);
  }
  return `timed out while ${last}`;
}

let project: string | undefined;

describe.skipIf(!runtime.available)(
  `the packaged container image (${runtime.reason})`,
  () => {
    beforeAll(async () => {
      project = createEngineProject();
      const harness = createTestContext({ cwd: project });

      // The manifest is already written, so `init` skips it and adds the
      // scaffolds; `package` then produces the container build context.
      expect(await runInit([], harness.context)).toBe(0);
      expect(await runPackage([], harness.context)).toBe(0);
      expect(harness.stderr.join("")).toContain("created Dockerfile");

      const built = docker(["build", "--tag", imageTag, "."], {
        cwd: project,
        timeoutMs: 900_000,
      });
      if (built.status !== 0) {
        // The builder's own tail is the only useful diagnostic here.
        throw new Error(
          `the image did not build:\n${`${built.stdout}${built.stderr}`.slice(-4_000)}`,
        );
      }
    }, 960_000);

    afterAll(() => {
      docker(["rm", "--force", containerName]);
      docker(["rmi", "--force", imageTag]);
      if (project !== undefined) {
        rmSync(project, { force: true, recursive: true });
      }
    }, 120_000);

    it("starts as non-root, reports healthy, and serves an authenticated initialize", async () => {
      const hostPort = await reservePort();
      const started = docker([
        "run",
        "--detach",
        "--name",
        containerName,
        "--publish",
        `127.0.0.1:${String(hostPort)}:${String(imagePort)}`,
        "--env",
        `${bearerVariable}=${bearerToken}`,
        imageTag,
      ]);
      expect(started.status).toBe(0);

      // The image declares USER node, and the process really runs as it.
      const uid = docker([
        "exec",
        containerName,
        "node",
        "-e",
        "process.stdout.write(String(process.getuid()))",
      ]);
      expect(uid.status).toBe(0);
      expect(uid.stdout.trim()).not.toBe("0");

      // The generated deploy/healthcheck.mjs is what Docker runs, and it holds
      // the manifest's bearer variable, so healthy means an authenticated
      // initialize succeeded from inside the container.
      expect(await waitForHealthy(180_000)).toBe("healthy");

      const authenticated = await postInitialize(hostPort, bearerToken);
      expect(authenticated.status).toBe(200);
      const message = JSON.parse(authenticated.body) as {
        readonly jsonrpc: string;
        readonly result: { readonly protocolVersion: string };
      };
      expect(message.jsonrpc).toBe("2.0");
      expect(message.result.protocolVersion).toBe(probeProtocolVersion);

      const unauthenticated = await postInitialize(hostPort);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.challenge.toLowerCase()).toContain("bearer");

      // Nothing the operator injected may reach the image definition.
      const history = docker(["image", "history", "--no-trunc", imageTag]);
      expect(history.stdout).not.toContain(bearerToken);
    }, 300_000);
  },
);

describe("the container smoke-test gate", () => {
  it("states whether a container runtime was available", () => {
    expect(runtime.reason.length).toBeGreaterThan(0);
    if (!runtime.available) {
      expect(runtime.reason.startsWith("no container runtime:")).toBe(true);
    }
  });
});
