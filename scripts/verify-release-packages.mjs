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
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "ai-engine-release-verify-"));
const checkoutDirectory = join(temporaryRoot, "checkout");
const artifactDirectory = join(temporaryRoot, "artifacts");
const consumerDirectory = join(temporaryRoot, "consumer");
const distEntryFiles = ["dist/index.js", "dist/index.d.ts"];
const publicPackages = [
  { directory: "core", name: "@ai-engine/core", requiredFiles: distEntryFiles },
  { directory: "cli", name: "@ai-engine/cli", requiredFiles: distEntryFiles },
  { directory: "mcp", name: "@ai-engine/mcp", requiredFiles: distEntryFiles },
  {
    directory: "tooling",
    name: "@ai-engine/tooling",
    // The dev-only package also ships the `ai-engine` executable.
    requiredFiles: [...distEntryFiles, "dist/cli.js"],
  },
];

function run(command, args, options = {}) {
  const standardInput = options.input === undefined ? "inherit" : "pipe";
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
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
      { name: "ai-engine-release-smoke", private: true, type: "module" },
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
    const core = await import("@ai-engine/core");
    const cli = await import("@ai-engine/cli");
    const mcp = await import("@ai-engine/mcp");
    const tooling = await import("@ai-engine/tooling");
    if (typeof core.createEngine !== "function") throw new Error("core import failed");
    if (typeof cli.runCli !== "function") throw new Error("cli import failed");
    if (typeof mcp.serveMcpStdio !== "function") throw new Error("mcp import failed");
    if (typeof tooling.checkCapabilities !== "function") throw new Error("tooling import failed");
  `;
  run("node", ["--input-type=module", "--eval", smokeProgram], {
    cwd: consumerDirectory,
  });

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
    return packageReport.name;
  });

  process.stdout.write(
    `Verified clean release tarballs and isolated ESM imports: ${packageNames.join(", ")}\n`,
  );
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
