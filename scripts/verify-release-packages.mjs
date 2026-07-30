#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
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
    directory: "installer",
    name: "@invokta/installer",
    // The installer is binary-first and intentionally has no import API.
    requiredFiles: [
      "dist/cli.js",
      "registry/capabilities.json",
      "registry/README.md",
    ],
  },
  {
    directory: "deploy",
    name: "@invokta/deploy",
    // The toolkit ships both an import API and the `invokta-deploy` executable.
    requiredFiles: [...distEntryFiles, "dist/bin.js"],
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

function writeGeneratedMcpSmoke(projectDirectory) {
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
      assert.equal(initialized.result.serverInfo.name, "release-engine");
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
    if (typeof core.createEngine !== "function") throw new Error("core import failed");
    if (typeof cli.runCli !== "function") throw new Error("cli import failed");
    if (typeof mcp.serveMcpStdio !== "function") throw new Error("mcp import failed");
    if (typeof tooling.checkCapabilities !== "function") throw new Error("tooling import failed");
    if (typeof deploy.runDeployCli !== "function") throw new Error("deploy import failed");
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
  const creatorOutput = run(
    creatorCommand,
    ["release-engine", "--package-manager", "npm", "--no-install"],
    {
      cwd: generatedDirectory,
      capture: true,
      env: { NODE_OPTIONS: `--no-warnings --import=${networkSentinel}` },
    },
  );
  if (!creatorOutput.startsWith("Created release-engine without installing")) {
    throw new Error("creator scaffold smoke failed");
  }

  const generatedProjectDirectory = join(generatedDirectory, "release-engine");
  verifyGeneratedAgentInstructions(
    generatedProjectDirectory,
    "create-invokta-engine",
  );
  const generatedManifest = JSON.parse(
    readFileSync(join(generatedProjectDirectory, "package.json"), "utf8"),
  );
  for (const packageName of ["@invokta/core", "@invokta/cli", "@invokta/mcp"]) {
    if (generatedManifest.dependencies?.[packageName] !== releaseVersion) {
      throw new Error(
        `generated ${packageName} version is not release-aligned`,
      );
    }
  }
  if (
    generatedManifest.devDependencies?.["@invokta/installer"] !== releaseVersion
  ) {
    throw new Error(
      "generated @invokta/installer version is not release-aligned",
    );
  }
  if (existsSync(join(generatedProjectDirectory, "src", "mcp-http.ts"))) {
    throw new Error("creator unexpectedly generated an HTTP entry point");
  }

  const generatedDependencyTarballs = [
    tarballsByName.get("@invokta/core"),
    tarballsByName.get("@invokta/cli"),
    tarballsByName.get("@invokta/mcp"),
    tarballsByName.get("@invokta/installer"),
  ];
  if (generatedDependencyTarballs.some((tarball) => tarball === undefined)) {
    throw new Error("generated consumer tarballs are incomplete");
  }
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...generatedDependencyTarballs,
    ],
    { cwd: generatedProjectDirectory },
  );
  run("npm", ["run", "--silent", "check"], {
    cwd: generatedProjectDirectory,
  });

  const directResult = run("npm", ["run", "--silent", "direct", "--", "Ada"], {
    cwd: generatedProjectDirectory,
    capture: true,
  });
  if (directResult !== '{"message":"Welcome, Ada!"}\n') {
    throw new Error("generated direct entry point smoke failed");
  }
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
    { cwd: generatedProjectDirectory, capture: true },
  );
  if (cliResult !== '{"message":"Welcome, Ada!"}\n') {
    throw new Error("generated CLI entry point smoke failed");
  }
  writeGeneratedMcpSmoke(generatedProjectDirectory);
  run("node", ["mcp-smoke.mjs"], { cwd: generatedProjectDirectory });

  const capabilityCreatorCases = [
    {
      command: "create-invokta-capability",
      target: "release-capability",
      expectedExports: ["createWelcomeMessageExport"],
      generatesAgentInstructions: false,
    },
    {
      command: "create-invokta-capability-library",
      target: "release-capability-library",
      expectedExports: ["onboardingCapabilityLibrary"],
      generatesAgentInstructions: true,
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
