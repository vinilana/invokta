import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import { acquireInstallerLocks } from "../../dist/installer-lock.js";
import { createNodeFileSystem } from "../../dist/node-file-system.js";

const [role, statePath, configPath] = process.argv.slice(2);

if (
  (role !== "holder" && role !== "contender") ||
  statePath === undefined ||
  configPath === undefined ||
  typeof process.send !== "function"
) {
  throw new Error("Invalid transaction lock fixture invocation.");
}

const audit = globalThis.__INVOKTA_TRANSACTION_LOCK_IO_AUDIT__;
if (audit === undefined) {
  throw new Error("The transaction lock I/O sentinel was not installed.");
}

function auditSnapshot() {
  return {
    commandAttempts: [...audit.commandAttempts],
    commandGuards: [...audit.commandGuards],
    networkAttempts: [...audit.networkAttempts],
    networkGuards: [...audit.networkGuards],
  };
}

function send(message) {
  return new Promise((resolve, reject) => {
    process.send({ ...message, audit: auditSnapshot() }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function waitForRelease() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("The holder release command timed out.")),
      10_000,
    );
    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };
    process.once("disconnect", finish);
    process.once("message", (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        message.type === "release"
      ) {
        finish();
        return;
      }
      clearTimeout(timeout);
      reject(new Error("The holder received an invalid command."));
    });
  });
}

const dependencies = {
  clock: {
    monotonicNow: () => performance.now(),
    now: () => Date.now(),
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
  fileSystem: createNodeFileSystem(),
  processId: process.pid,
  randomBytes,
};

async function runHolder() {
  const lease = await acquireInstallerLocks({
    configPath,
    dependencies,
    statePath,
  });
  await send({ type: "acquired", paths: lease.paths });
  try {
    await waitForRelease();
  } finally {
    await lease.release();
  }
  await send({ type: "released" });
}

async function runContender() {
  const startedAt = performance.now();
  try {
    const lease = await acquireInstallerLocks({
      configPath,
      dependencies,
      statePath,
    });
    await lease.release();
    await send({
      type: "unexpected-acquired",
      elapsedMilliseconds: performance.now() - startedAt,
    });
    process.exitCode = 1;
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    await send({
      type: "failed",
      code,
      elapsedMilliseconds: performance.now() - startedAt,
    });
    if (code !== "STATE_LOCKED") process.exitCode = 1;
  }
}

try {
  if (role === "holder") await runHolder();
  else await runContender();
} catch (error) {
  await send({
    type: "fixture-error",
    message: error instanceof Error ? error.message : "Unknown fixture error.",
  }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
