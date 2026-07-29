// Preloaded with --import so every child-process entry point is replaced
// before the toolkit is loaded. Each guard records the attempt and throws, so a
// command that spawned anything is observable as both a recorded name and a
// failed run rather than as a silently tolerated call.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const attempts = [];
globalThis.__INVOKTA_DEPLOY_PROCESS_ATTEMPTS__ = attempts;

function guard(name) {
  return function forbidProcessExecution() {
    attempts.push(name);
    throw new Error(`DEPLOY_PROCESS_EXECUTION_FORBIDDEN:${name}`);
  };
}

const methods = [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
];

for (const method of methods) childProcess[method] = guard(method);
childProcess.ChildProcess.prototype.spawn = guard("ChildProcess.spawn");
syncBuiltinESMExports();

// A sentinel that failed to install would let every later assertion pass
// vacuously, so each guard proves it throws before anything is measured.
for (const method of methods) {
  let thrown;
  try {
    childProcess[method]();
  } catch (error) {
    thrown = error;
  }
  if (
    !(thrown instanceof Error) ||
    !thrown.message.startsWith("DEPLOY_PROCESS_EXECUTION_FORBIDDEN:")
  ) {
    throw new Error(`PROCESS_SENTINEL_SELF_PROBE_FAILED:${method}`);
  }
}

attempts.length = 0;
