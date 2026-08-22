#!/usr/bin/env node

/**
 * Runs the published conformance gates over every built example engine.
 *
 * `invokta check-mcp` (ADR 0026) and `invokta check-capabilities` (ADR 0009)
 * are the gates a generated project runs in its own `check`. The examples are
 * engines too, so the repository runs the same commands against them after the
 * workspace build instead of trusting that their manifests declare the scripts.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = join(repositoryRoot, "examples");
const toolingCli = join(
  repositoryRoot,
  "packages",
  "tooling",
  "dist",
  "cli.js",
);

const gates = [
  { script: "check:mcp", command: "check-mcp", module: "dist/engine.js" },
  {
    script: "check:capabilities",
    command: "check-capabilities",
    module: "dist/capabilities.js",
  },
];

function readManifest(directory) {
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function runGate(exampleName, directory, gate) {
  const modulePath = join(directory, gate.module);
  if (!existsSync(modulePath)) {
    throw new Error(
      `${exampleName} declares "${gate.script}" but ${gate.module} is missing. Build the workspace first.`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [toolingCli, gate.command, modulePath],
    {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${exampleName}: invokta ${gate.command} failed with exit code ${String(result.status)}.`,
    );
  }
  return `${exampleName} ${gate.command}`;
}

if (!existsSync(toolingCli)) {
  process.stderr.write(
    "check-examples: build the workspace before running the example gates.\n",
  );
  process.exit(2);
}

const passed = [];
const failures = [];
for (const entry of readdirSync(examplesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(examplesRoot, entry.name);
  const manifest = readManifest(directory);
  const scripts = manifest?.scripts ?? {};
  for (const gate of gates) {
    if (typeof scripts[gate.script] !== "string") continue;
    try {
      passed.push(runGate(entry.name, directory, gate));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exit(1);
}

process.stderr.write(
  `check-examples: ${String(passed.length)} example gates passed.\n`,
);
