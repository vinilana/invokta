import { types as nodeTypes } from "node:util";

import {
  attachedCliError,
  type ParsedCliTarget,
} from "./cli-attached-contract.js";

const unixDefaultEnvNames = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
] as const;

const windowsDefaultEnvNames = [
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERNAME",
  "USERPROFILE",
  "PROGRAMFILES",
] as const;

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultEnvironment(
  platform: NodeJS.Platform,
  readHostEnv: (name: string) => string | undefined,
): Record<string, string> {
  const names =
    platform === "win32" ? windowsDefaultEnvNames : unixDefaultEnvNames;
  const env = Object.create(null) as Record<string, string>;
  for (const name of names) {
    const value = readHostEnv(name);
    if (typeof value !== "string" || value.startsWith("()")) continue;
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return env;
}

export function composeAttachedCliEnvironment(
  overlay: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  readHostEnv: (name: string) => string | undefined,
): Record<string, string> {
  const env = defaultEnvironment(platform, readHostEnv);
  for (const name of Object.keys(overlay)) {
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      value: overlay[name],
      writable: true,
    });
  }
  return env;
}

export function parseAttachedCliTarget(value: unknown): ParsedCliTarget {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    throw attachedCliError("INVALID_TARGET");
  }
  const command = ownDataProperty(value, "command");
  if (typeof command !== "string" || command.trim() === "") {
    throw attachedCliError("INVALID_TARGET");
  }
  const rawArgs = ownDataProperty(value, "args");
  let args: readonly string[] = [];
  if (rawArgs !== undefined) {
    if (
      !Array.isArray(rawArgs) ||
      rawArgs.some((entry) => typeof entry !== "string")
    ) {
      throw attachedCliError("INVALID_TARGET");
    }
    args = rawArgs;
  }
  const cwd = ownDataProperty(value, "cwd");
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) {
    throw attachedCliError("INVALID_TARGET");
  }
  const rawEnv = ownDataProperty(value, "env");
  const overlay = Object.create(null) as Record<string, string>;
  if (rawEnv !== undefined) {
    if (!isPlainRecord(rawEnv) || nodeTypes.isProxy(rawEnv)) {
      throw attachedCliError("INVALID_TARGET");
    }
    for (const name of Object.keys(rawEnv)) {
      if (!environmentNamePattern.test(name)) {
        throw attachedCliError("INVALID_TARGET");
      }
      const entry = ownDataProperty(rawEnv, name);
      if (typeof entry !== "string") throw attachedCliError("INVALID_TARGET");
      if (entry === "") throw attachedCliError("ENVIRONMENT_VALUE_MISSING");
      Object.defineProperty(overlay, name, {
        configurable: true,
        enumerable: true,
        value: entry,
        writable: true,
      });
    }
  }
  return {
    command,
    args,
    ...(typeof cwd === "string" ? { cwd } : {}),
    overlay,
  };
}
