// Drives the published toolkit surface under the process-execution and network
// sentinels: a complete `init`, a complete `package`, and every `probe`
// rejection that must be decided before any I/O. The report on stdout is the
// evidence the test asserts against; an unexpected result throws here so a
// silent behavior change cannot be read as a clean run.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDeployContext,
  runInit,
  runPackage,
  runProbe,
} from "../../dist/index.js";

const processAttempts = globalThis.__INVOKTA_DEPLOY_PROCESS_ATTEMPTS__;
const networkAttempts = globalThis.__INVOKTA_DEPLOY_NETWORK_ATTEMPTS__;

if (!Array.isArray(processAttempts) || !Array.isArray(networkAttempts)) {
  throw new Error("SENTINELS_NOT_INSTALLED");
}

const stdout = [];
const stderr = [];

function contextAt(cwd) {
  return createDeployContext({
    cwd,
    env: {},
    io: {
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
  });
}

function expectExitCode(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`UNEXPECTED_EXIT_CODE:${label}:${actual}:${expected}`);
  }
  return actual;
}

const project = join(
  tmpdir(),
  `invokta-deploy-sentinel-${process.pid.toString(36)}`,
);
rmSync(project, { force: true, recursive: true });
mkdirSync(project, { recursive: true });

let report;
try {
  const initExitCode = expectExitCode(
    "init",
    await runInit([], contextAt(project)),
    0,
  );
  const initFiles = readdirSync(project).sort();

  // `package` reads a project package.json, exactly one lockfile, and the built
  // entry the manifest names; none of that may reach a package manager.
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "sentinel-engine",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { build: "tsc -b" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(join(project, "package-lock.json"), "{}\n", "utf8");
  mkdirSync(join(project, "dist"), { recursive: true });
  writeFileSync(join(project, "dist/mcp-http.js"), "// built output\n", "utf8");

  const packageExitCode = expectExitCode(
    "package",
    await runPackage([], contextAt(project)),
    0,
  );
  const packageFiles = readdirSync(project).sort();

  // Every rejection below is decided from the arguments and the environment
  // alone, so a probe that reached the network would be recorded by the
  // sentinel even though the exit code is the same.
  const probeRejections = [
    ["no url", []],
    ["dangling flag", ["--url"]],
    ["unknown flag", ["--url", "https://engine.example/mcp", "--force"]],
    ["not a url", ["--url", "not-a-url"]],
    ["missing mcp path", ["--url", "https://engine.example/"]],
    ["userinfo", ["--url", "https://user:pass@engine.example/mcp"]],
    ["plain http off loopback", ["--url", "http://engine.example/mcp"]],
    [
      "unknown expectation",
      ["--url", "https://engine.example/mcp", "--expect", "bogus"],
    ],
    [
      "bearer without readiness",
      ["--url", "https://engine.example/mcp", "--bearer-env", "TOKEN"],
    ],
    [
      "timeout out of range",
      ["--url", "https://engine.example/mcp", "--timeout-ms", "0"],
    ],
    [
      "unset bearer variable",
      [
        "--url",
        "https://engine.example/mcp",
        "--expect",
        "ready",
        "--bearer-env",
        "ABSENT_TOKEN",
      ],
    ],
  ];

  const probeExitCodes = [];
  for (const [label, args] of probeRejections) {
    probeExitCodes.push(
      expectExitCode(
        `probe:${label}`,
        await runProbe(args, contextAt(project)),
        2,
      ),
    );
  }

  report = {
    initExitCode,
    initFiles,
    packageExitCode,
    packageFiles,
    probeExitCodes,
    processAttempts: [...processAttempts],
    networkAttempts: [...networkAttempts],
    stdout: stdout.join(""),
  };
} finally {
  rmSync(project, { force: true, recursive: true });
}

if (processAttempts.length > 0 || networkAttempts.length > 0) {
  throw new Error(
    `SENTINEL_VIOLATION:${processAttempts.join(",")}|${networkAttempts.join(",")}`,
  );
}

process.stdout.write(`${JSON.stringify(report)}\n`);
