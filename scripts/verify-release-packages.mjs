#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "invokta-release-verify-"));
const checkoutDirectory = join(temporaryRoot, "checkout");
const artifactDirectory = join(temporaryRoot, "artifacts");
const consumerDirectory = join(temporaryRoot, "consumer");
const generatedDirectory = join(temporaryRoot, "generated");
const scriptExecutable = execFileSync("which", ["script"], {
  encoding: "utf8",
}).trim();
const distEntryFiles = ["dist/index.js", "dist/index.d.ts"];
const repositoryUrl = "git+https://github.com/vinilana/invokta.git";
const issuesUrl = "https://github.com/vinilana/invokta/issues";
const documentationUrl = "https://docs.invokta.dev";
const packageAuthor = "Vini Lana <vini@aicoders.academy>";
const publicPackages = [
  { directory: "core", name: "@invokta/core", requiredFiles: distEntryFiles },
  { directory: "cli", name: "@invokta/cli", requiredFiles: distEntryFiles },
  { directory: "mcp", name: "@invokta/mcp", requiredFiles: distEntryFiles },
  {
    directory: "tooling",
    name: "@invokta/tooling",
    // The dev-only package also ships the `invokta` executable.
    requiredFiles: [...distEntryFiles, "dist/cli.js"],
  },
  {
    directory: "devtools",
    name: "@invokta/devtools",
    // The dev-only package ships the executable and the interface bundle.
    requiredFiles: [...distEntryFiles, "dist/cli.js", "dist/ui/app.js"],
  },
  {
    directory: "installer",
    name: "@invokta/installer",
    // The installer is binary-first; its only import API is the engine subpath.
    requiredFiles: [
      "dist/cli.js",
      "dist/engine-cli.js",
      "dist/engine-cli.d.ts",
      "registry/capabilities.json",
      "registry/README.md",
    ],
  },
  {
    directory: "deploy",
    name: "@invokta/deploy",
    // The toolkit ships both an import API and the `invokta-deploy` executable.
    requiredFiles: [
      ...distEntryFiles,
      "dist/bin.js",
      "dist/scaffold-public.js",
      "dist/scaffold-public.d.ts",
    ],
  },
  {
    directory: "create-invokta-engine",
    name: "create-invokta-engine",
    // The creator is binary-only and ships no import API.
    requiredFiles: ["dist/bin.js"],
  },
  {
    directory: "create-invokta-capability",
    name: "create-invokta-capability",
    // The creator is binary-only and ships no import API.
    requiredFiles: ["dist/bin.js"],
  },
  {
    directory: "create-invokta-capability-library",
    name: "create-invokta-capability-library",
    // The creator is binary-only and ships no import API.
    requiredFiles: ["dist/bin.js"],
  },
];

function run(command, args, options = {}) {
  const standardInput = options.input === undefined ? "inherit" : "pipe";
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env:
      options.env === undefined
        ? process.env
        : { ...process.env, ...options.env },
    input: options.input,
    stdio: options.capture
      ? [standardInput, "pipe", "inherit"]
      : [standardInput, "inherit", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${String(result.status)}`,
    );
  }

  return result.stdout ?? "";
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runInteractive(command, args, options) {
  return new Promise((resolveInteractive, rejectInteractive) => {
    const child = spawn(
      scriptExecutable,
      [
        "--quiet",
        "--return",
        "--command",
        [command, ...args].map(shellQuote).join(" "),
        "/dev/null",
      ],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let submitted = false;
    const timeout = setTimeout(() => {
      child.kill();
      rejectInteractive(
        new Error(`interactive command timed out\n${stdout}\n${stderr}`),
      );
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!submitted && stdout.includes(options.waitFor)) {
        submitted = true;
        setTimeout(() => child.stdin.write(options.input), 250);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectInteractive(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectInteractive(
          new Error(
            `interactive command failed with exit code ${String(code)}\n${stdout}\n${stderr}`,
          ),
        );
        return;
      }
      resolveInteractive(stdout);
    });
  });
}

function failReleaseMetadata(message) {
  throw new Error(`Release metadata check failed: ${message}`);
}

function requireEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failReleaseMetadata(`${label} must be ${JSON.stringify(expected)}`);
  }
}

function verifyGeneratedAgentInstructions(projectDirectory, creatorName) {
  const agentsPath = join(projectDirectory, "AGENTS.md");
  const claudePath = join(projectDirectory, "CLAUDE.md");
  if (!lstatSync(agentsPath).isFile()) {
    throw new Error(`${creatorName} did not generate AGENTS.md as a file`);
  }
  if (!lstatSync(claudePath).isSymbolicLink()) {
    throw new Error(`${creatorName} did not generate CLAUDE.md as a symlink`);
  }
  if (readlinkSync(claudePath) !== "AGENTS.md") {
    throw new Error(`${creatorName} generated an invalid CLAUDE.md target`);
  }
}

function verifyGeneratedDevelopmentSkill(
  projectDirectory,
  creatorName,
  expectedHeading,
) {
  const skillDirectory = join(
    projectDirectory,
    ".agents",
    "skills",
    "develop-invokta-project",
  );
  const skillPath = join(skillDirectory, "SKILL.md");
  const metadataPath = join(skillDirectory, "agents", "openai.yaml");
  if (!lstatSync(skillPath).isFile() || !lstatSync(metadataPath).isFile()) {
    throw new Error(`${creatorName} did not generate regular skill files`);
  }

  const skill = readFileSync(skillPath, "utf8");
  if (
    !/^---\nname: develop-invokta-project\ndescription: [^\n]+\n---\n/u.test(
      skill,
    ) ||
    !skill.includes(expectedHeading) ||
    skill.includes("TODO")
  ) {
    throw new Error(`${creatorName} generated an invalid development skill`);
  }

  const metadata = readFileSync(metadataPath, "utf8");
  if (
    !metadata.startsWith("interface:\n") ||
    !metadata.includes("display_name:") ||
    !metadata.includes("short_description:") ||
    !metadata.includes("default_prompt:") ||
    !metadata.includes("$develop-invokta-project")
  ) {
    throw new Error(`${creatorName} generated invalid skill metadata`);
  }
}

function verifyRootReleaseMetadata(packageReport) {
  const releaseVersion = packageReport.version;
  if (
    typeof releaseVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseVersion)
  ) {
    failReleaseMetadata("the root package version must be a release version");
  }

  requireEqual(packageReport.name, "invokta", "root package name");
  requireEqual(packageReport.private, true, "root package private flag");
  requireEqual(packageReport.license, "MIT", "root package license");
  requireEqual(packageReport.author, packageAuthor, "root package author");
  requireEqual(
    packageReport.repository,
    { type: "git", url: repositoryUrl },
    "root package repository",
  );
  requireEqual(
    packageReport.homepage,
    `${documentationUrl}/`,
    "root package homepage",
  );
  requireEqual(packageReport.bugs, { url: issuesUrl }, "root package bugs URL");
  if (
    typeof packageReport.description !== "string" ||
    !packageReport.description
  ) {
    failReleaseMetadata("the root package must declare a description");
  }

  return releaseVersion;
}

function verifyPublicPackageReleaseMetadata(
  packageReport,
  publicPackage,
  releaseVersion,
) {
  const label = publicPackage.name;
  requireEqual(packageReport.name, label, `${label} name`);
  requireEqual(packageReport.version, releaseVersion, `${label} version`);
  requireEqual(packageReport.license, "MIT", `${label} license`);
  requireEqual(packageReport.author, packageAuthor, `${label} author`);
  requireEqual(
    packageReport.repository,
    {
      type: "git",
      url: repositoryUrl,
      directory: `packages/${publicPackage.directory}`,
    },
    `${label} repository`,
  );
  requireEqual(
    packageReport.homepage,
    `${documentationUrl}/reference/${publicPackage.directory}/`,
    `${label} homepage`,
  );
  requireEqual(packageReport.bugs, { url: issuesUrl }, `${label} bugs URL`);
  requireEqual(
    packageReport.publishConfig?.access,
    "public",
    `${label} publish access`,
  );
  if (
    typeof packageReport.description !== "string" ||
    !packageReport.description
  ) {
    failReleaseMetadata(`${label} must declare a description`);
  }
  if (packageReport.private === true) {
    failReleaseMetadata(`${label} must be publishable`);
  }

  for (const [dependency, version] of Object.entries(
    packageReport.dependencies ?? {},
  )) {
    if (dependency.startsWith("@invokta/") && version !== releaseVersion) {
      failReleaseMetadata(
        `${label} dependency ${dependency} must use version ${releaseVersion}`,
      );
    }
  }
}

function verifyChangelog(changelog, releaseVersion) {
  const escapedVersion = releaseVersion.replaceAll(".", "\\.");
  if (
    !new RegExp(
      `^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`,
      "mu",
    ).test(changelog)
  ) {
    failReleaseMetadata(
      `CHANGELOG.md is missing a dated ${releaseVersion} entry`,
    );
  }

  const releaseLink = `[${releaseVersion}]: https://github.com/vinilana/invokta/releases/tag/v${releaseVersion}`;
  if (!changelog.includes(releaseLink)) {
    failReleaseMetadata(
      `CHANGELOG.md is missing the ${releaseVersion} release link`,
    );
  }
}

function writeGeneratedMcpSmoke(projectDirectory, projectName) {
  const program = `
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { createInterface } from "node:readline";

    const child = spawn(process.execPath, ["dist/mcp-stdio.js"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const childError = new Promise((_, reject) => child.once("error", reject));
    const childExit = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );

    function withTimeout(promise, label) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 5_000);
      });
      return Promise.race([promise, childError, timeout]).finally(() =>
        clearTimeout(timer),
      );
    }

    async function nextMessage() {
      const result = await withTimeout(
        Promise.race([
          iterator.next(),
          childExit.then(() => {
            throw new Error("MCP server exited before its response");
          }),
        ]),
        "MCP response timed out",
      );
      if (result.done) throw new Error("MCP stdout ended before its response");
      return JSON.parse(result.value);
    }

    function send(message) {
      child.stdin.write(\`\${JSON.stringify(message)}\\n\`);
    }

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "creator-release-smoke", version: "0.0.0-test" },
        },
      });
      const initialized = await nextMessage();
      assert.equal(initialized.id, 1);
      assert.equal(initialized.result.serverInfo.name, ${JSON.stringify(projectName)});
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "onboarding.create-welcome-message",
          arguments: { name: "Ada" },
        },
      });
      const called = await nextMessage();
      assert.equal(called.id, 2);
      assert.deepEqual(called.result.structuredContent, {
        message: "Welcome, Ada!",
      });
      child.stdin.end();
      const result = await withTimeout(childExit, "MCP server exit timed out");
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(stderr, "");
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  `;
  writeFileSync(join(projectDirectory, "mcp-smoke.mjs"), program);
}

function listGeneratedEntries(projectDirectory, relativeDirectory = "") {
  const directory = join(projectDirectory, relativeDirectory);
  const entries = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (relativeDirectory === "" && item.name === "node_modules") continue;
    const relativePath =
      relativeDirectory === ""
        ? item.name
        : `${relativeDirectory}/${item.name}`;
    if (item.isDirectory()) {
      entries.push(...listGeneratedEntries(projectDirectory, relativePath));
    } else {
      entries.push(relativePath);
    }
  }
  return entries.sort();
}

function writeGeneratedHttpPlanSmoke(projectDirectory) {
  const program = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    import {
      createMcpHttpScaffoldFiles,
      starterDeployManifest,
    } from "@invokta/deploy/scaffold";

    const files = createMcpHttpScaffoldFiles(starterDeployManifest);
    assert.equal(Object.isFrozen(files), true);
    for (const file of files) {
      assert.equal(Object.isFrozen(file), true);
      assert.equal(readFileSync(file.path, "utf8"), file.contents);
    }
  `;
  writeFileSync(join(projectDirectory, "http-plan-smoke.mjs"), program);
}

function writeGeneratedHttpAuthFixture(projectDirectory) {
  const source = `import { timingSafeEqual } from "node:crypto";

import type { McpHttpAuthOptions } from "@invokta/mcp";

const expectedCredential = process.env.RELEASE_HTTP_TOKEN;
if (expectedCredential === undefined || expectedCredential === "") {
  throw new Error("The release HTTP fixture token is missing.");
}

export const httpAuth = {
  mode: "required",
  authenticate(request) {
    const authorization = request.headers.get("authorization");
    if (authorization === null) return null;
    const expected = Buffer.from(\`Bearer \${expectedCredential}\`, "utf8");
    const received = Buffer.from(authorization, "utf8");
    if (received.length !== expected.length) return null;
    if (!timingSafeEqual(received, expected)) return null;
    return { id: "release:http-client" };
  },
} satisfies McpHttpAuthOptions;
`;
  writeFileSync(join(projectDirectory, "src", "http-auth.ts"), source);
}

function writeGeneratedHttpSmoke(projectDirectory, projectName) {
  const program = `
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";

    import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

    const token = "release-http-fixture-token";
    const child = spawn(process.execPath, ["dist/mcp-http.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        INVOKTA_HTTP_PORT: "0",
        RELEASE_HTTP_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const childExit = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );

    function withTimeout(promise, label) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 5_000);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    try {
      const port = await withTimeout(new Promise((resolve, reject) => {
        child.stderr.on("data", () => {
          const match = stderr.match(/127\\.0\\.0\\.1:(\\d+)\\/mcp/u);
          if (match?.[1] !== undefined) resolve(Number(match[1]));
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(\`HTTP server exited before startup: \${String(code)}\`)),
        );
      }), "HTTP server startup timed out");
      const transport = new StreamableHTTPClientTransport(
        new URL(\`http://127.0.0.1:\${port}/mcp\`),
        { requestInit: { headers: { authorization: \`Bearer \${token}\` } } },
      );
      const client = new Client(
        { name: "creator-http-release-smoke", version: "0.0.0-test" },
        { capabilities: {} },
      );
      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: "onboarding.create-welcome-message",
          arguments: { name: "Ada" },
        });
        assert.deepEqual(result.structuredContent, {
          message: "Welcome, Ada!",
        });
      } finally {
        await client.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      const result = await withTimeout(childExit, "HTTP server exit timed out");
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
    }
    assert.equal(stdout, "");
    assert.equal(stderr.includes(token), false);
    assert.match(stderr, /MCP endpoint:/u);
    assert.equal(${JSON.stringify(projectName)}.length > 0, true);
  `;
  writeFileSync(join(projectDirectory, "http-smoke.mjs"), program);
}

function writeGeneratedInstallerFixture(projectDirectory) {
  const program = `
    import assert from "node:assert/strict";
    import { join } from "node:path";

    import { loadEngineInstallManifest } from "./node_modules/@invokta/installer/dist/engine-manifest.js";
    import { installDescriptorAcrossTargets } from "./node_modules/@invokta/installer/dist/mutation-coordinator.js";
    import { createNodeFileSystem } from "./node_modules/@invokta/installer/dist/node-file-system.js";
    import { configurationTargetAdapters } from "./node_modules/@invokta/installer/dist/target-adapters.js";

    const homeDirectory = process.env.HOME;
    assert.ok(homeDirectory);
    const fileSystem = createNodeFileSystem();
    const source = await loadEngineInstallManifest({
      currentUserId: process.getuid?.() ?? 0,
      fileSystem,
      nodeExecutable: process.execPath,
      projectDirectory: process.cwd(),
    });
    let now = Date.parse("2026-07-30T12:00:00.000Z");
    const results = await installDescriptorAcrossTargets({
      dependencies: {
        adapters: configurationTargetAdapters,
        currentUserId: process.getuid?.() ?? 0,
        environment: { get: (name) => process.env[name] },
        fileSystem,
        lock: {
          clock: {
            monotonicNow: () => now,
            now: () => now,
            wait: async (milliseconds) => { now += milliseconds; },
          },
          processId: process.pid,
          randomBytes: (length) => new Uint8Array(length).fill(7),
        },
        now: () => new Date(now).toISOString(),
      },
      descriptor: source.descriptor,
      snapshot: {
        homeDirectory,
        surfaces: [],
        targets: [{
          id: "codex",
          displayName: "Codex",
          surfaceIds: [],
          evidence: "configuration-only",
          executables: [],
          configuration: {
            kind: "present",
            path: join(homeDirectory, ".codex", "config.toml"),
          },
          eligible: true,
          mayCreateConfiguration: false,
          reloadHint: "Reload Codex.",
        }],
      },
      targetIds: ["codex"],
    });
    assert.deepEqual(results, [{ targetId: "codex", outcome: "installed" }]);
  `;
  writeFileSync(join(projectDirectory, "installer-fixture.mjs"), program);
}

try {
  mkdirSync(checkoutDirectory);
  mkdirSync(artifactDirectory);
  mkdirSync(consumerDirectory);
  mkdirSync(generatedDirectory);

  const indexTree = execFileSync("git", ["write-tree"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  // The archive is written to disk rather than buffered through Node, whose
  // default maxBuffer would truncate it as the repository grows.
  const archivePath = join(temporaryRoot, "checkout.tar");
  execFileSync(
    "git",
    ["archive", "--format=tar", "--output", archivePath, indexTree],
    { cwd: repositoryRoot },
  );
  run("tar", ["-xf", archivePath, "-C", checkoutDirectory]);

  run("yarn", ["install", "--frozen-lockfile", "--non-interactive"], {
    cwd: checkoutDirectory,
  });

  const rootPackageReport = JSON.parse(
    readFileSync(join(checkoutDirectory, "package.json"), "utf8"),
  );
  const releaseVersion = verifyRootReleaseMetadata(rootPackageReport);
  verifyChangelog(
    readFileSync(join(checkoutDirectory, "CHANGELOG.md"), "utf8"),
    releaseVersion,
  );

  const tarballs = [];
  const tarballsByName = new Map();

  for (const publicPackage of publicPackages) {
    const packageDirectory = join(
      checkoutDirectory,
      "packages",
      publicPackage.directory,
    );
    verifyPublicPackageReleaseMetadata(
      JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")),
      publicPackage,
      releaseVersion,
    );
    const reportText = run(
      "npm",
      ["pack", "--json", "--pack-destination", artifactDirectory],
      { cwd: packageDirectory, capture: true },
    );
    const report = JSON.parse(reportText)[0];

    if (!report || typeof report.filename !== "string") {
      throw new Error(
        `npm pack did not report a ${publicPackage.directory} tarball`,
      );
    }

    const fileNames = new Set(
      report.files
        .map((file) => file.path)
        .filter((path) => typeof path === "string"),
    );

    if (!fileNames.has("LICENSE")) {
      throw new Error(`${publicPackage.directory} tarball is missing LICENSE`);
    }

    for (const requiredFile of publicPackage.requiredFiles) {
      if (!fileNames.has(requiredFile)) {
        throw new Error(
          `${publicPackage.directory} tarball is missing ${requiredFile}`,
        );
      }
    }

    const tarball = join(artifactDirectory, report.filename);
    tarballs.push(tarball);
    tarballsByName.set(publicPackage.name, tarball);
  }

  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      { name: "invokta-release-smoke", private: true, type: "module" },
      null,
      2,
    )}\n`,
  );

  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    { cwd: consumerDirectory },
  );

  const smokeProgram = `
    const core = await import("@invokta/core");
    const cli = await import("@invokta/cli");
    const mcp = await import("@invokta/mcp");
    const tooling = await import("@invokta/tooling");
    const deploy = await import("@invokta/deploy");
    const deployScaffold = await import("@invokta/deploy/scaffold");
    const installerEngine = await import("@invokta/installer/engine");
    if (typeof core.createEngine !== "function") throw new Error("core import failed");
    if (typeof cli.runCli !== "function") throw new Error("cli import failed");
    if (typeof mcp.serveMcpStdio !== "function") throw new Error("mcp import failed");
    if (typeof tooling.checkCapabilities !== "function") throw new Error("tooling import failed");
    if (typeof deploy.runDeployCli !== "function") throw new Error("deploy import failed");
    if (typeof deployScaffold.createMcpHttpScaffoldFiles !== "function") throw new Error("deploy scaffold import failed");
    if (typeof installerEngine.runEngineInstallerCli !== "function") throw new Error("installer engine import failed");
  `;
  run("node", ["--input-type=module", "--eval", smokeProgram], {
    cwd: consumerDirectory,
  });

  const installerCommand = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    "invokta-installer",
  );
  const installerPackageDirectory = join(
    consumerDirectory,
    "node_modules",
    "@invokta",
    "installer",
  );
  const installerPackageReport = JSON.parse(
    readFileSync(join(installerPackageDirectory, "package.json"), "utf8"),
  );
  const sentinelDirectory = join(
    checkoutDirectory,
    "packages",
    "installer",
    "test",
    "fixtures",
  );
  const eagerLoadSentinel = pathToFileURL(
    join(sentinelDirectory, "forbid-eager-installer-loads.mjs"),
  ).href;
  const networkSentinel = pathToFileURL(
    join(sentinelDirectory, "forbid-network-access.mjs"),
  ).href;

  const creatorCommand = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    "create-invokta-engine",
  );
  const creatorVersion = run(creatorCommand, ["--version"], {
    cwd: generatedDirectory,
    capture: true,
    env: { NODE_OPTIONS: `--no-warnings --import=${networkSentinel}` },
  });
  if (creatorVersion !== `${releaseVersion}\n`) {
    throw new Error("creator binary version smoke failed");
  }
  const commonCreatorEntries = [
    ".agents/skills/develop-invokta-project/SKILL.md",
    ".agents/skills/develop-invokta-project/agents/openai.yaml",
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "package.json",
    "src/capabilities/create-welcome-message.ts",
    "src/direct.ts",
    "src/engine.ts",
    "test/engine.test.ts",
    "tsconfig.json",
    "tsconfig.test.json",
  ];
  const httpCreatorEntries = [
    ".env.example",
    "invokta.deploy.json",
    "src/env.ts",
    "src/http-auth.ts",
    "src/mcp-http.ts",
  ];
  const creatorProfileCases = [
    {
      profile: "complete",
      label: "complete",
      target: "release-engine",
      entries: [
        ...commonCreatorEntries,
        ...httpCreatorEntries,
        "invokta.mcp.json",
        "src/bin.ts",
        "src/cli.ts",
        "src/mcp-stdio.ts",
      ],
      dependencies: [
        "@invokta/cli",
        "@invokta/core",
        "@invokta/installer",
        "@invokta/mcp",
      ],
      devDependencies: ["@invokta/deploy"],
      scripts: [
        "build",
        "check",
        "cli",
        "deploy:package",
        "deploy:probe",
        "direct",
        "mcp:http",
        "mcp:install",
        "mcp:stdio",
        "mcp:uninstall",
        "test",
        "typecheck",
      ],
      cli: true,
      mcpStdio: true,
      mcpHttp: true,
      omittedDocumentation: [],
      legacyNonTerminal: true,
    },
    {
      profile: "mcp-stdio",
      label: "MCP local",
      target: "release-engine-stdio",
      entries: [
        ...commonCreatorEntries,
        "invokta.mcp.json",
        "src/bin.ts",
        "src/mcp-stdio.ts",
      ],
      dependencies: ["@invokta/core", "@invokta/installer", "@invokta/mcp"],
      devDependencies: [],
      scripts: [
        "build",
        "check",
        "direct",
        "mcp:install",
        "mcp:stdio",
        "mcp:uninstall",
        "test",
        "typecheck",
      ],
      cli: false,
      mcpStdio: true,
      mcpHttp: false,
      omittedDocumentation: ["CLI", "MCP HTTP"],
      legacyNonTerminal: false,
    },
    {
      profile: "mcp-http",
      label: "MCP HTTP",
      target: "release-engine-http",
      entries: [...commonCreatorEntries, ...httpCreatorEntries],
      dependencies: ["@invokta/core", "@invokta/mcp"],
      devDependencies: ["@invokta/deploy"],
      scripts: [
        "build",
        "check",
        "deploy:package",
        "deploy:probe",
        "direct",
        "mcp:http",
        "test",
        "typecheck",
      ],
      cli: false,
      mcpStdio: false,
      mcpHttp: true,
      omittedDocumentation: ["CLI", "MCP local", "MCP stdio"],
      legacyNonTerminal: false,
    },
    {
      profile: "cli",
      label: "CLI",
      target: "release-engine-cli",
      entries: [...commonCreatorEntries, "src/cli.ts"],
      dependencies: ["@invokta/cli", "@invokta/core"],
      devDependencies: [],
      scripts: ["build", "check", "cli", "direct", "test", "typecheck"],
      cli: true,
      mcpStdio: false,
      mcpHttp: false,
      omittedDocumentation: ["MCP"],
      legacyNonTerminal: false,
      pseudoTty: true,
    },
  ];
  const generatedProfileDirectories = new Map();

  for (const profileCase of creatorProfileCases) {
    const creatorArguments = [
      profileCase.target,
      ...(profileCase.legacyNonTerminal
        ? []
        : ["--profile", profileCase.profile]),
      "--package-manager",
      "npm",
      "--no-install",
      ...(profileCase.pseudoTty ? ["--yes"] : []),
    ];
    const creatorEnvironment = {
      NODE_OPTIONS: `--no-warnings --import=${networkSentinel}`,
    };
    const creatorOutput = profileCase.pseudoTty
      ? run(
          scriptExecutable,
          [
            "--quiet",
            "--return",
            "--command",
            [creatorCommand, ...creatorArguments].map(shellQuote).join(" "),
            "/dev/null",
          ],
          {
            cwd: generatedDirectory,
            capture: true,
            env: creatorEnvironment,
          },
        )
      : run(creatorCommand, creatorArguments, {
          cwd: generatedDirectory,
          capture: true,
          input: "",
          env: creatorEnvironment,
        });
    if (
      !creatorOutput.includes(
        `Created ${profileCase.target} with the ${profileCase.label} scaffold.`,
      )
    ) {
      throw new Error(`${profileCase.profile} creator scaffold smoke failed`);
    }

    const projectDirectory = join(generatedDirectory, profileCase.target);
    generatedProfileDirectories.set(profileCase.profile, projectDirectory);
    verifyGeneratedDevelopmentSkill(
      projectDirectory,
      "create-invokta-engine",
      "# Develop This Action Engine",
    );
    verifyGeneratedAgentInstructions(projectDirectory, "create-invokta-engine");
    requireEqual(
      listGeneratedEntries(projectDirectory),
      [...profileCase.entries].sort(),
      `${profileCase.profile} packed creator entries`,
    );

    const generatedManifest = JSON.parse(
      readFileSync(join(projectDirectory, "package.json"), "utf8"),
    );
    requireEqual(
      Object.keys(generatedManifest.dependencies ?? {})
        .filter((name) => name.startsWith("@invokta/"))
        .sort(),
      profileCase.dependencies,
      `${profileCase.profile} generated dependencies`,
    );
    requireEqual(
      Object.keys(generatedManifest.devDependencies ?? {})
        .filter((name) => name.startsWith("@invokta/"))
        .sort(),
      profileCase.devDependencies,
      `${profileCase.profile} generated development dependencies`,
    );
    requireEqual(
      Object.keys(generatedManifest.scripts ?? {}).sort(),
      profileCase.scripts,
      `${profileCase.profile} generated scripts`,
    );
    for (const packageName of [
      ...profileCase.dependencies,
      ...profileCase.devDependencies,
    ]) {
      const version =
        generatedManifest.dependencies?.[packageName] ??
        generatedManifest.devDependencies?.[packageName];
      if (version !== releaseVersion) {
        throw new Error(
          `${profileCase.profile} generated ${packageName} version is not release-aligned`,
        );
      }
    }
    const generatedDocumentation = [
      "README.md",
      "AGENTS.md",
      ".agents/skills/develop-invokta-project/SKILL.md",
    ]
      .map((path) => readFileSync(join(projectDirectory, path), "utf8"))
      .join("\n");
    for (const token of profileCase.omittedDocumentation) {
      if (generatedDocumentation.includes(token)) {
        throw new Error(
          `${profileCase.profile} documentation advertises omitted ${token}`,
        );
      }
    }

    const generatedDependencyTarballs = [
      ...profileCase.dependencies,
      ...profileCase.devDependencies,
    ].map((name) => tarballsByName.get(name));
    if (generatedDependencyTarballs.some((tarball) => tarball === undefined)) {
      throw new Error(
        `${profileCase.profile} generated consumer tarballs are incomplete`,
      );
    }
    run(
      "npm",
      [
        "install",
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...generatedDependencyTarballs,
      ],
      { cwd: projectDirectory },
    );
    run("npm", ["run", "--silent", "check"], { cwd: projectDirectory });

    const directResult = run(
      "npm",
      ["run", "--silent", "direct", "--", "Ada"],
      { cwd: projectDirectory, capture: true },
    );
    if (directResult !== '{"message":"Welcome, Ada!"}\n') {
      throw new Error(`${profileCase.profile} direct entry point smoke failed`);
    }
    if (profileCase.cli) {
      const cliResult = run(
        "npm",
        [
          "run",
          "--silent",
          "cli",
          "--",
          "run",
          "onboarding.create-welcome-message",
          "--input",
          '{"name":"Ada"}',
        ],
        { cwd: projectDirectory, capture: true },
      );
      if (cliResult !== '{"message":"Welcome, Ada!"}\n') {
        throw new Error(`${profileCase.profile} CLI entry point smoke failed`);
      }
    }
    if (profileCase.mcpStdio) {
      writeGeneratedMcpSmoke(projectDirectory, profileCase.target);
      run("node", ["mcp-smoke.mjs"], { cwd: projectDirectory });
    }
    if (profileCase.mcpHttp) {
      writeGeneratedHttpPlanSmoke(projectDirectory);
      run("node", ["http-plan-smoke.mjs"], { cwd: projectDirectory });
      const refused = spawnSync(process.execPath, ["dist/mcp-http.js"], {
        cwd: projectDirectory,
        encoding: "utf8",
        env: { ...process.env, INVOKTA_HTTP_PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (
        refused.status === 0 ||
        refused.stdout !== "" ||
        refused.stderr !==
          "Implement authentication before deploying: edit src/http-auth.ts.\n"
      ) {
        throw new Error(
          `${profileCase.profile} untouched HTTP auth stub did not fail closed`,
        );
      }
      writeGeneratedHttpAuthFixture(projectDirectory);
      run("npm", ["run", "--silent", "check"], { cwd: projectDirectory });
      writeGeneratedHttpSmoke(projectDirectory, profileCase.target);
      run("node", ["http-smoke.mjs"], { cwd: projectDirectory });
    }
  }

  const generatedProjectDirectory = generatedProfileDirectories.get("complete");
  if (generatedProjectDirectory === undefined) {
    throw new Error("complete generated profile is missing");
  }

  const generatedEnginePackReport = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", artifactDirectory], {
      cwd: generatedProjectDirectory,
      capture: true,
    }),
  )[0];
  if (
    !generatedEnginePackReport ||
    typeof generatedEnginePackReport.filename !== "string"
  ) {
    throw new Error("generated engine pack did not report a tarball");
  }
  const generatedEngineTarball = join(
    artifactDirectory,
    generatedEnginePackReport.filename,
  );
  run(
    "npm",
    [
      "install",
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      generatedEngineTarball,
    ],
    { cwd: consumerDirectory },
  );
  const generatedEngineCommand = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    "release-engine",
  );
  const generatedEngineHelp = run(generatedEngineCommand, ["--help"], {
    cwd: consumerDirectory,
    capture: true,
    env: { NODE_OPTIONS: `--no-warnings --import=${networkSentinel}` },
  });
  if (
    generatedEngineHelp !==
    "Usage:\n  release-engine install\n  release-engine uninstall\n  release-engine --help\n"
  ) {
    throw new Error("packed generated engine binary help smoke failed");
  }

  const installerFixtureHome = join(temporaryRoot, "installer-home");
  const installerFixtureBin = join(installerFixtureHome, "bin");
  const installerFixtureState = join(installerFixtureHome, ".state");
  const installerFixtureConfig = join(
    installerFixtureHome,
    ".codex",
    "config.toml",
  );
  mkdirSync(installerFixtureBin, { recursive: true });
  mkdirSync(dirname(installerFixtureConfig), { recursive: true });
  mkdirSync(installerFixtureState, { recursive: true });
  symlinkSync(process.execPath, join(installerFixtureBin, "node"));
  symlinkSync("/bin/sh", join(installerFixtureBin, "sh"));
  const configurationPreimage = "# packed uninstall fixture\n";
  writeFileSync(installerFixtureConfig, configurationPreimage);
  const installerFixtureEnvironment = {
    HOME: installerFixtureHome,
    PATH: installerFixtureBin,
    XDG_STATE_HOME: installerFixtureState,
  };
  writeGeneratedInstallerFixture(generatedProjectDirectory);
  run(process.execPath, ["installer-fixture.mjs"], {
    cwd: generatedProjectDirectory,
    env: installerFixtureEnvironment,
  });
  if (
    !readFileSync(installerFixtureConfig, "utf8").includes("release-engine")
  ) {
    throw new Error("packed installer fixture did not install the engine");
  }
  rmSync(join(generatedProjectDirectory, "dist", "mcp-stdio.js"));
  const npmExecutable = execFileSync("which", ["npm"], {
    encoding: "utf8",
  }).trim();
  await runInteractive(npmExecutable, ["run", "--silent", "mcp:uninstall"], {
    cwd: generatedProjectDirectory,
    env: installerFixtureEnvironment,
    input: "y\n",
    waitFor: "Engine uninstall preflight",
  });
  const uninstalledConfiguration = readFileSync(installerFixtureConfig, "utf8");
  if (
    !uninstalledConfiguration.includes(configurationPreimage.trim()) ||
    uninstalledConfiguration.includes("release-engine")
  ) {
    throw new Error("generated uninstall did not preserve unrelated config");
  }
  const installerFixtureStateReport = JSON.parse(
    readFileSync(
      join(installerFixtureState, "invokta", "installer.json"),
      "utf8",
    ),
  );
  if (Object.keys(installerFixtureStateReport.installations).length !== 0) {
    throw new Error("generated uninstall left managed engine state behind");
  }

  const capabilityCreatorCases = [
    {
      command: "create-invokta-capability",
      target: "release-capability",
      expectedExports: ["createWelcomeMessageExport"],
      generatesAgentInstructions: false,
      expectedSkillHeading: "# Develop This Atomic Capability",
    },
    {
      command: "create-invokta-capability-library",
      target: "release-capability-library",
      expectedExports: ["onboardingCapabilityLibrary"],
      generatesAgentInstructions: true,
      expectedSkillHeading: "# Develop This Capability Library",
    },
  ];
  for (const creatorCase of capabilityCreatorCases) {
    const command = join(
      consumerDirectory,
      "node_modules",
      ".bin",
      creatorCase.command,
    );
    const version = run(command, ["--version"], {
      cwd: generatedDirectory,
      capture: true,
      env: { NODE_OPTIONS: `--no-warnings --import=${networkSentinel}` },
    });
    if (version !== `${releaseVersion}\n`) {
      throw new Error(`${creatorCase.command} binary version smoke failed`);
    }
    const output = run(
      command,
      [creatorCase.target, "--package-manager", "npm", "--no-install"],
      {
        cwd: generatedDirectory,
        capture: true,
        env: { NODE_OPTIONS: `--no-warnings --import=${networkSentinel}` },
      },
    );
    if (
      !output.startsWith(`Created ${creatorCase.target} without installing`)
    ) {
      throw new Error(`${creatorCase.command} scaffold smoke failed`);
    }

    const projectDirectory = join(generatedDirectory, creatorCase.target);
    verifyGeneratedDevelopmentSkill(
      projectDirectory,
      creatorCase.command,
      creatorCase.expectedSkillHeading,
    );
    if (creatorCase.generatesAgentInstructions) {
      verifyGeneratedAgentInstructions(projectDirectory, creatorCase.command);
    }
    const manifest = JSON.parse(
      readFileSync(join(projectDirectory, "package.json"), "utf8"),
    );
    if (
      manifest.private !== true ||
      manifest.dependencies?.["@invokta/core"] !== releaseVersion
    ) {
      throw new Error(
        `${creatorCase.command} generated manifest is not release-aligned`,
      );
    }
    const coreTarball = tarballsByName.get("@invokta/core");
    if (coreTarball === undefined) {
      throw new Error("generated capability consumer tarball is incomplete");
    }
    run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", coreTarball],
      { cwd: projectDirectory },
    );
    run("npm", ["run", "--silent", "check"], { cwd: projectDirectory });

    const exportedNames = JSON.parse(
      run(
        "node",
        [
          "--input-type=module",
          "--eval",
          'import("./dist/index.js").then((module) => process.stdout.write(JSON.stringify(Object.keys(module)) + "\\n"))',
        ],
        { cwd: projectDirectory, capture: true },
      ),
    );
    if (
      JSON.stringify(exportedNames) !==
      JSON.stringify(creatorCase.expectedExports)
    ) {
      throw new Error(`${creatorCase.command} root export smoke failed`);
    }
  }

  const installerVersion = run(installerCommand, ["--version"], {
    cwd: consumerDirectory,
    capture: true,
    env: {
      INVOKTA_INSTALLER_DIST_ROOT: join(installerPackageDirectory, "dist"),
      NODE_OPTIONS: `--no-warnings --experimental-loader=${eagerLoadSentinel} --import=${networkSentinel}`,
    },
  });
  if (installerVersion !== `${installerPackageReport.version}\n`) {
    throw new Error("installer binary version smoke failed");
  }

  const deployCommand = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    "invokta-deploy",
  );
  const deployPackageReport = JSON.parse(
    readFileSync(
      join(
        consumerDirectory,
        "node_modules",
        "@invokta",
        "deploy",
        "package.json",
      ),
      "utf8",
    ),
  );
  // The eager-load sentinel is scoped to the installer module graph, so the
  // deploy binary is pinned by the reusable network sentinel alone.
  const deployVersion = run(deployCommand, ["--version"], {
    cwd: consumerDirectory,
    capture: true,
    env: {
      NODE_OPTIONS: `--no-warnings --import=${networkSentinel}`,
    },
  });
  if (deployVersion !== `${deployPackageReport.version}\n`) {
    throw new Error("deploy binary version smoke failed");
  }

  const packageNames = publicPackages.map((publicPackage) => {
    const packageReport = JSON.parse(
      readFileSync(
        join(
          consumerDirectory,
          "node_modules",
          publicPackage.name,
          "package.json",
        ),
        "utf8",
      ),
    );
    verifyPublicPackageReleaseMetadata(
      packageReport,
      publicPackage,
      releaseVersion,
    );
    return packageReport.name;
  });

  process.stdout.write(
    `Verified Invokta ${releaseVersion} metadata, clean release tarballs, isolated ESM imports, and executable smoke: ${packageNames.join(", ")}\n`,
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
