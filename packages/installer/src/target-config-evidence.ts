import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { InstallerFileSystem } from "./file-system.js";
import type {
  TargetConfigEvidence,
  TargetConfigEvidenceProbe,
  TargetConfigEvidenceProbes,
} from "./harness-detection.js";

export interface InstallerEnvironment {
  readonly get: (name: string) => unknown;
}

export interface CreateNodeTargetConfigEvidenceProbesOptions {
  readonly environment: InstallerEnvironment;
  readonly fileSystem: InstallerFileSystem;
  readonly currentUserId?: number;
}

interface ResolvedTargetConfigEvidenceProbeOptions
  extends Omit<CreateNodeTargetConfigEvidenceProbesOptions, "currentUserId"> {
  readonly currentUserId: number | undefined;
}

type ConfigEvidenceCode = Extract<
  TargetConfigEvidence,
  { readonly kind: "blocked" }
>["code"];

function blocked(code: ConfigEvidenceCode): TargetConfigEvidence {
  return Object.freeze({ kind: "blocked", code });
}

function isInsideHome(
  homeDirectory: string,
  candidate: string,
  allowHome = false,
): boolean {
  if (!isAbsolute(homeDirectory) || !isAbsolute(candidate)) return false;
  if (homeDirectory.includes("\0") || candidate.includes("\0")) return false;
  const normalizedHome = resolve(homeDirectory);
  const normalizedCandidate = resolve(candidate);
  const difference = relative(normalizedHome, normalizedCandidate);
  if (difference === "") return allowHome;
  return (
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function absoluteOverride(
  environment: InstallerEnvironment,
  name: string,
  homeDirectory: string,
):
  | { readonly kind: "unset" }
  | { readonly kind: "valid"; readonly path: string }
  | { readonly kind: "invalid" } {
  let value: unknown;
  try {
    value = environment.get(name);
  } catch {
    return { kind: "invalid" };
  }
  if (value === undefined) return { kind: "unset" };
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    return { kind: "invalid" };
  }
  const path = resolve(value);
  return isInsideHome(homeDirectory, path, true)
    ? { kind: "valid", path }
    : { kind: "invalid" };
}

function openClawOverride(
  environment: InstallerEnvironment,
  name: string,
  operatingSystemHome: string,
  tildeHome: string,
):
  | { readonly kind: "unset" }
  | { readonly kind: "valid"; readonly path: string }
  | { readonly kind: "invalid" } {
  let value: unknown;
  try {
    value = environment.get(name);
  } catch {
    return { kind: "invalid" };
  }
  if (value === undefined) return { kind: "unset" };
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0")
  ) {
    return { kind: "invalid" };
  }
  const path =
    value === "~"
      ? tildeHome
      : value.startsWith(`~${sep}`)
        ? join(tildeHome, value.slice(2))
        : value;
  if (!isAbsolute(path)) return { kind: "invalid" };
  const normalizedPath = resolve(path);
  return isInsideHome(operatingSystemHome, normalizedPath, true)
    ? { kind: "valid", path: normalizedPath }
    : { kind: "invalid" };
}

async function inspectSingleConfig(
  options: ResolvedTargetConfigEvidenceProbeOptions,
  homeDirectory: string,
  path: string,
): Promise<TargetConfigEvidence> {
  if (!isInsideHome(homeDirectory, path)) {
    return blocked("HARNESS_CONFIG_UNSAFE");
  }
  const inspection = await inspectOwnedPath(
    options,
    homeDirectory,
    path,
    "regular-file",
  );
  if (inspection === "read-failed") {
    return blocked("HARNESS_CONFIG_READ_FAILED");
  }
  if (inspection === "unsafe") return blocked("HARNESS_CONFIG_UNSAFE");
  return inspection === "missing"
    ? Object.freeze({ kind: "absent" })
    : Object.freeze({ kind: "present", path: resolve(path) });
}

type OwnedPathInspection = "present" | "missing" | "unsafe" | "read-failed";

async function inspectOwnedPath(
  options: ResolvedTargetConfigEvidenceProbeOptions,
  homeDirectory: string,
  targetPath: string,
  expectedTargetKind: "regular-file" | "directory",
): Promise<OwnedPathInspection> {
  const currentUserId = options.currentUserId;
  if (
    currentUserId === undefined ||
    !Number.isSafeInteger(currentUserId) ||
    currentUserId < 0
  ) {
    return "unsafe";
  }
  const normalizedHome = resolve(homeDirectory);
  const normalizedTarget = resolve(targetPath);
  if (
    !isInsideHome(
      normalizedHome,
      normalizedTarget,
      expectedTargetKind === "directory",
    )
  ) {
    return "unsafe";
  }
  const difference = relative(normalizedHome, normalizedTarget);
  const componentPaths = [normalizedHome];
  if (difference !== "") {
    let componentPath = normalizedHome;
    for (const component of difference.split(sep)) {
      componentPath = join(componentPath, component);
      componentPaths.push(componentPath);
    }
  }

  let realHome: string | undefined;
  let previousRealPath: string | undefined;
  try {
    for (const [index, componentPath] of componentPaths.entries()) {
      const inspection = await options.fileSystem.inspectPath(componentPath);
      if (inspection.kind === "missing") return "missing";
      if (inspection.ownerId !== currentUserId) return "unsafe";
      if (inspection.kind === "symbolic-link" || inspection.kind === "other") {
        return "unsafe";
      }
      const isTarget = index === componentPaths.length - 1;
      const expectedKind = isTarget ? expectedTargetKind : "directory";
      if (inspection.kind !== expectedKind) return "unsafe";
      if (
        !isAbsolute(inspection.realPath) ||
        inspection.realPath.includes("\0")
      ) {
        return "unsafe";
      }
      const normalizedRealPath = resolve(inspection.realPath);
      if (index === 0) {
        realHome = normalizedRealPath;
      } else if (
        realHome === undefined ||
        !isInsideHome(realHome, normalizedRealPath) ||
        previousRealPath === undefined ||
        dirname(normalizedRealPath) !== previousRealPath
      ) {
        return "unsafe";
      }
      previousRealPath = normalizedRealPath;
    }
    return "present";
  } catch {
    return "read-failed";
  }
}

function singleConfigProbe(
  options: ResolvedTargetConfigEvidenceProbeOptions,
  relativeDefault: string,
  override?: { readonly name: string; readonly fileName: string },
): TargetConfigEvidenceProbe {
  return async ({ homeDirectory }) => {
    if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    let path = join(resolve(homeDirectory), relativeDefault);
    if (override !== undefined) {
      const selection = absoluteOverride(
        options.environment,
        override.name,
        homeDirectory,
      );
      if (selection.kind === "invalid") {
        return blocked("HARNESS_CONFIG_UNSAFE");
      }
      if (selection.kind === "valid") {
        path = join(selection.path, override.fileName);
      }
    }
    return inspectSingleConfig(options, homeDirectory, path);
  };
}

function openCodeProbe(
  options: ResolvedTargetConfigEvidenceProbeOptions,
): TargetConfigEvidenceProbe {
  return async ({ homeDirectory }) => {
    if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    const direct = absoluteOverride(
      options.environment,
      "OPENCODE_CONFIG_DIR",
      homeDirectory,
    );
    if (direct.kind === "invalid") return blocked("HARNESS_CONFIG_UNSAFE");
    let directory: string;
    if (direct.kind === "valid") {
      directory = direct.path;
    } else {
      const xdg = absoluteOverride(
        options.environment,
        "XDG_CONFIG_HOME",
        homeDirectory,
      );
      if (xdg.kind === "invalid") return blocked("HARNESS_CONFIG_UNSAFE");
      directory = join(
        xdg.kind === "valid" ? xdg.path : join(homeDirectory, ".config"),
        "opencode",
      );
    }
    const candidates = [
      join(directory, "opencode.json"),
      join(directory, "opencode.jsonc"),
    ];
    if (candidates.some((path) => !isInsideHome(homeDirectory, path))) {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    const inspections = await Promise.all(
      candidates.map(async (path) =>
        inspectOwnedPath(options, homeDirectory, path, "regular-file"),
      ),
    );
    if (inspections.includes("read-failed")) {
      return blocked("HARNESS_CONFIG_READ_FAILED");
    }
    if (inspections.includes("unsafe")) {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    const existing = candidates.filter(
      (_, index) => inspections[index] === "present",
    );
    if (existing.length > 1) return blocked("HARNESS_CONFIG_AMBIGUOUS");
    const path = existing[0];
    return path === undefined
      ? Object.freeze({ kind: "absent" })
      : Object.freeze({ kind: "present", path });
  };
}

function openClawProbe(
  options: ResolvedTargetConfigEvidenceProbeOptions,
): TargetConfigEvidenceProbe {
  return async ({ homeDirectory }) => {
    if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    let profile: unknown;
    try {
      profile = options.environment.get("OPENCLAW_PROFILE");
    } catch {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    if (profile !== undefined) {
      if (typeof profile !== "string") return blocked("HARNESS_CONFIG_UNSAFE");
      const normalizedProfile = profile.trim();
      if (
        normalizedProfile !== "" &&
        normalizedProfile.toLowerCase() !== "default"
      ) {
        return blocked("TARGET_UNSUPPORTED");
      }
    }

    const operatingSystemHome = resolve(homeDirectory);
    const effectiveHomeOverride = openClawOverride(
      options.environment,
      "OPENCLAW_HOME",
      operatingSystemHome,
      operatingSystemHome,
    );
    if (effectiveHomeOverride.kind === "invalid") {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    const effectiveHome =
      effectiveHomeOverride.kind === "valid"
        ? effectiveHomeOverride.path
        : operatingSystemHome;
    const effectiveHomeInspection = await inspectOwnedPath(
      options,
      operatingSystemHome,
      effectiveHome,
      "directory",
    );
    if (effectiveHomeInspection === "read-failed") {
      return blocked("HARNESS_CONFIG_READ_FAILED");
    }
    if (effectiveHomeInspection === "unsafe") {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    const direct = openClawOverride(
      options.environment,
      "OPENCLAW_CONFIG_PATH",
      operatingSystemHome,
      effectiveHome,
    );
    if (direct.kind === "invalid") return blocked("HARNESS_CONFIG_UNSAFE");
    if (direct.kind === "valid") {
      return inspectSingleConfig(options, operatingSystemHome, direct.path);
    }

    const state = openClawOverride(
      options.environment,
      "OPENCLAW_STATE_DIR",
      operatingSystemHome,
      effectiveHome,
    );
    if (state.kind === "invalid") return blocked("HARNESS_CONFIG_UNSAFE");
    const candidates = [
      ...(state.kind === "valid"
        ? [join(state.path, "openclaw.json"), join(state.path, "clawdbot.json")]
        : []),
      join(effectiveHome, ".openclaw", "openclaw.json"),
      join(effectiveHome, ".openclaw", "clawdbot.json"),
      join(effectiveHome, ".clawdbot", "openclaw.json"),
      join(effectiveHome, ".clawdbot", "clawdbot.json"),
    ];
    if (candidates.some((path) => !isInsideHome(operatingSystemHome, path))) {
      return blocked("HARNESS_CONFIG_UNSAFE");
    }
    for (const path of candidates) {
      const inspection = await inspectOwnedPath(
        options,
        operatingSystemHome,
        path,
        "regular-file",
      );
      if (inspection === "present") {
        return Object.freeze({ kind: "present", path });
      }
      if (inspection === "unsafe") return blocked("HARNESS_CONFIG_UNSAFE");
      if (inspection === "read-failed") {
        return blocked("HARNESS_CONFIG_READ_FAILED");
      }
    }
    return Object.freeze({ kind: "absent" });
  };
}

export function createProcessInstallerEnvironment(): InstallerEnvironment {
  return Object.freeze({ get: (name: string): unknown => process.env[name] });
}

export function createNodeTargetConfigEvidenceProbes(
  options: CreateNodeTargetConfigEvidenceProbesOptions,
): TargetConfigEvidenceProbes {
  const resolvedOptions: ResolvedTargetConfigEvidenceProbeOptions = {
    ...options,
    currentUserId:
      options.currentUserId ??
      (typeof process.getuid === "function" ? process.getuid() : undefined),
  };
  return Object.freeze({
    antigravity: singleConfigProbe(
      resolvedOptions,
      ".gemini/config/mcp_config.json",
    ),
    "claude-code": singleConfigProbe(resolvedOptions, ".claude.json", {
      name: "CLAUDE_CONFIG_DIR",
      fileName: ".claude.json",
    }),
    codex: singleConfigProbe(resolvedOptions, ".codex/config.toml", {
      name: "CODEX_HOME",
      fileName: "config.toml",
    }),
    cursor: singleConfigProbe(resolvedOptions, ".cursor/mcp.json"),
    "grok-build": singleConfigProbe(resolvedOptions, ".grok/config.toml", {
      name: "GROK_HOME",
      fileName: "config.toml",
    }),
    hermes: singleConfigProbe(resolvedOptions, ".hermes/config.yaml", {
      name: "HERMES_HOME",
      fileName: "config.yaml",
    }),
    "kimi-code": singleConfigProbe(resolvedOptions, ".kimi-code/mcp.json", {
      name: "KIMI_CODE_HOME",
      fileName: "mcp.json",
    }),
    openclaw: openClawProbe(resolvedOptions),
    "opencode-v2": openCodeProbe(resolvedOptions),
  });
}
