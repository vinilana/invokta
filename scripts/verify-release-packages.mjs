#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const distEntryFiles = ["dist/index.js", "dist/index.d.ts"];
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

try {
  mkdirSync(checkoutDirectory);
  mkdirSync(artifactDirectory);
  mkdirSync(consumerDirectory);

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

  const tarballs = [];

  for (const publicPackage of publicPackages) {
    const packageDirectory = join(
      checkoutDirectory,
      "packages",
      publicPackage.directory,
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

    tarballs.push(join(artifactDirectory, report.filename));
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
    if (packageReport.name !== publicPackage.name) {
      throw new Error(
        `${publicPackage.directory} installed as ${packageReport.name}`,
      );
    }
    if (packageReport.license !== "MIT") {
      throw new Error(
        `${publicPackage.directory} package does not declare the MIT license`,
      );
    }
    if (packageReport.publishConfig?.access !== "public") {
      throw new Error(
        `${publicPackage.directory} package is not configured for public access`,
      );
    }
    return packageReport.name;
  });

  process.stdout.write(
    `Verified clean release tarballs, isolated ESM imports, and executable smoke: ${packageNames.join(", ")}\n`,
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
