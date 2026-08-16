#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const manifestPath = fileURLToPath(
  new URL("./release-packages.json", import.meta.url),
);

function fail(message) {
  throw new Error(`Invalid release package manifest: ${message}`);
}

function validateRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    fail(`${label} must be a non-empty repository-relative path`);
  }
  return value;
}

const parsedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Array.isArray(parsedManifest) || parsedManifest.length === 0) {
  fail("the root must be a non-empty array");
}

const seenDirectories = new Set();
const seenNames = new Set();
export const releasePackages = Object.freeze(
  parsedManifest.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(`entry ${index} must be an object`);
    }
    const directory = validateRelativePath(
      entry.directory,
      `entry ${index} directory`,
    );
    if (directory.includes("/")) {
      fail(`entry ${index} directory must be relative to packages`);
    }
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      fail(`entry ${index} name must be a non-empty string`);
    }
    if (seenDirectories.has(directory)) {
      fail(`duplicate directory ${directory}`);
    }
    if (seenNames.has(entry.name)) {
      fail(`duplicate package name ${entry.name}`);
    }
    if (
      !Array.isArray(entry.requiredFiles) ||
      entry.requiredFiles.length === 0
    ) {
      fail(`${entry.name} must declare requiredFiles`);
    }
    const requiredFiles = entry.requiredFiles.map((file, fileIndex) =>
      validateRelativePath(file, `${entry.name} requiredFiles[${fileIndex}]`),
    );
    if (new Set(requiredFiles).size !== requiredFiles.length) {
      fail(`${entry.name} contains duplicate requiredFiles`);
    }
    seenDirectories.add(directory);
    seenNames.add(entry.name);
    return Object.freeze({
      directory,
      name: entry.name,
      requiredFiles: Object.freeze(requiredFiles),
    });
  }),
);

if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  if (process.argv.length !== 3 || process.argv[2] !== "shell-entries") {
    process.stderr.write(
      "Usage: node scripts/release/release-packages.mjs shell-entries\n",
    );
    process.exitCode = 2;
  } else {
    for (const entry of releasePackages) {
      process.stdout.write(`packages/${entry.directory}|${entry.name}\n`);
    }
  }
}
