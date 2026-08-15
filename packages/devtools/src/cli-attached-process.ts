import type { ChildProcess } from "node:child_process";

import {
  ATTACHED_CLI_SESSION_LIMITS,
  attachedCliError,
  type AttachedCliChildResult,
  type AttachedCliSessionClock,
  AttachedCliSessionError,
  type AttachedCliSpawn,
  type ParsedCliTarget,
} from "./cli-attached-contract.js";

export const attachedCliDeadlineReason = Object.freeze({
  type: "attached-cli-deadline",
});

function killChild(
  child: ChildProcess,
  clock: AttachedCliSessionClock,
  graceMs: number,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const handle = clock.schedule(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, graceMs);
  child.once("exit", () => {
    clock.cancel(handle);
  });
}

export function collectAttachedCliChild(
  spawn: AttachedCliSpawn,
  target: ParsedCliTarget,
  verbArgs: readonly string[],
  env: Record<string, string>,
  clock: AttachedCliSessionClock,
  killGraceMs: number,
  signal: AbortSignal,
): Promise<AttachedCliChildResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let overflow = false;
    let child: ChildProcess;
    try {
      child = spawn(target.command, [...target.args, ...verbArgs], {
        ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      reject(attachedCliError("SPAWN_FAILED", cause));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (
      error?: AttachedCliSessionError,
      result?: AttachedCliChildResult,
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };

    const onAbort = (): void => {
      killChild(child, clock, killGraceMs);
    };

    const onChunk = (
      stream: "stdout" | "stderr",
      value: Buffer | string,
    ): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (stream === "stdout") {
        if (
          stdoutBytes + chunk.length >
          ATTACHED_CLI_SESSION_LIMITS.streamBytes
        ) {
          overflow = true;
          killChild(child, clock, killGraceMs);
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        return;
      }
      if (
        stderrBytes + chunk.length >
        ATTACHED_CLI_SESSION_LIMITS.streamBytes
      ) {
        overflow = true;
        killChild(child, clock, killGraceMs);
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      onChunk("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      onChunk("stderr", chunk);
    });
    child.once("error", (cause) => {
      finish(attachedCliError("SPAWN_FAILED", cause));
    });
    child.once("exit", (code) => {
      if (overflow) {
        finish(attachedCliError("LIMIT_EXCEEDED"));
        return;
      }
      if (signal.aborted) {
        finish(
          attachedCliError(
            signal.reason === attachedCliDeadlineReason
              ? "TIMEOUT"
              : "NOT_CONNECTED",
          ),
        );
        return;
      }
      finish(undefined, {
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function runAttachedCliWithDeadline<Value>(
  clock: AttachedCliSessionClock,
  timeoutMs: number,
  controller: AbortController,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    let handle: unknown;
    const cleanup = (): void => {
      clock.cancel(handle);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: AttachedCliSessionError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      fail(
        attachedCliError(
          controller.signal.reason === attachedCliDeadlineReason
            ? "TIMEOUT"
            : "NOT_CONNECTED",
        ),
      );
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    handle = clock.schedule(() => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort(attachedCliDeadlineReason);
      reject(attachedCliError("TIMEOUT"));
    }, timeoutMs);

    let pending: Promise<Value>;
    try {
      pending = operation(controller.signal);
    } catch (cause) {
      fail(
        cause instanceof AttachedCliSessionError
          ? cause
          : attachedCliError("SPAWN_FAILED", cause),
      );
      return;
    }
    void pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          cause instanceof AttachedCliSessionError
            ? cause
            : attachedCliError("CONNECTION_FAILED", cause),
        );
      },
    );
  });
}
