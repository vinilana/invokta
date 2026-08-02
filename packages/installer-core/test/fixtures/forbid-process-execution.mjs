import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

function forbidProcessExecution() {
  throw new Error("INSTALLER_PROCESS_EXECUTION_FORBIDDEN");
}

for (const method of [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]) {
  childProcess[method] = forbidProcessExecution;
}

childProcess.ChildProcess.prototype.spawn = forbidProcessExecution;
syncBuiltinESMExports();
