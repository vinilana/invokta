import {
  configurationTargetCatalog,
  harnessSurfaceCatalog,
  type HarnessSurfaceId,
} from "./harness-catalog.js";
import type { InstallerErrorCode } from "./installer-error.js";
import type { ConfigurationTargetId } from "./registry.js";

export interface ExecutableIdentity {
  readonly device: number;
  readonly inode: number;
  readonly realPath: string;
}

export interface ExecutableEvidence {
  readonly path: string;
  readonly identity: ExecutableIdentity;
  readonly legacyAliasFor?: "agy";
}

export type ExecutableResolver = (
  candidate: string,
) => Promise<ExecutableEvidence | undefined>;

export type OperatingSystemHomeResolver = () => string;

export type TargetConfigEvidenceCode = Extract<
  InstallerErrorCode,
  | "HARNESS_CONFIG_UNSAFE"
  | "HARNESS_CONFIG_AMBIGUOUS"
  | "HARNESS_CONFIG_READ_FAILED"
  | "TARGET_UNSUPPORTED"
>;

export type TargetConfigEvidence =
  | { readonly kind: "present"; readonly path: string }
  | { readonly kind: "absent"; readonly path: string }
  | {
      readonly kind: "blocked";
      readonly code: TargetConfigEvidenceCode;
    };

export interface TargetConfigEvidenceContext {
  readonly homeDirectory: string;
  readonly targetId: ConfigurationTargetId;
  readonly executables?: readonly DetectedExecutable[];
}

export type TargetConfigEvidenceProbe = (
  context: TargetConfigEvidenceContext,
) => Promise<TargetConfigEvidence>;

export type TargetConfigEvidenceProbes = Readonly<
  Record<ConfigurationTargetId, TargetConfigEvidenceProbe>
>;

export interface DetectedExecutable extends ExecutableEvidence {
  readonly candidate: string;
}

export interface HarnessSurfaceSnapshot {
  readonly id: HarnessSurfaceId;
  readonly displayName: string;
  readonly targetId: ConfigurationTargetId;
  readonly evidence: "installed" | "absent";
  readonly executables: readonly DetectedExecutable[];
}

export interface ConfigurationTargetSnapshot {
  readonly id: ConfigurationTargetId;
  readonly displayName: string;
  readonly surfaceIds: readonly HarnessSurfaceId[];
  readonly evidence: "installed" | "configuration-only" | "blocked" | "absent";
  readonly executables: readonly DetectedExecutable[];
  readonly configuration: TargetConfigEvidence;
  readonly eligible: boolean;
  readonly mayCreateConfiguration: boolean;
  readonly reloadHint: string;
}

export interface HarnessDetectionSnapshot {
  readonly homeDirectory: string;
  readonly surfaces: readonly HarnessSurfaceSnapshot[];
  readonly targets: readonly ConfigurationTargetSnapshot[];
}

export interface DetectHarnessesOptions {
  readonly resolveHomeDirectory: OperatingSystemHomeResolver;
  readonly resolveExecutable: ExecutableResolver;
  readonly configEvidenceProbes: TargetConfigEvidenceProbes;
}

function executableIdentityKey(identity: ExecutableIdentity): string {
  return `${String(identity.device)}:${String(identity.inode)}`;
}

function freezeExecutable(
  candidate: string,
  evidence: ExecutableEvidence,
): DetectedExecutable {
  return Object.freeze({
    candidate,
    path: evidence.path,
    identity: Object.freeze({ ...evidence.identity }),
    ...(evidence.legacyAliasFor === undefined
      ? {}
      : { legacyAliasFor: evidence.legacyAliasFor }),
  });
}

function uniqueExecutables(
  executables: readonly DetectedExecutable[],
): readonly DetectedExecutable[] {
  const found: DetectedExecutable[] = [];
  const identities = new Set<string>();
  for (const executable of executables) {
    const key = executableIdentityKey(executable.identity);
    if (identities.has(key)) continue;
    identities.add(key);
    found.push(executable);
  }
  return Object.freeze(found);
}

async function detectSurfaceExecutables(
  candidates: readonly string[],
  resolveExecutable: ExecutableResolver,
): Promise<readonly DetectedExecutable[]> {
  const found: DetectedExecutable[] = [];
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const evidence = await resolveExecutable(candidate);
    if (evidence === undefined) continue;
    const key = executableIdentityKey(evidence.identity);
    if (identities.has(key)) continue;
    identities.add(key);
    found.push(freezeExecutable(candidate, evidence));
  }
  return Object.freeze(found);
}

function displayNameForTarget(
  targetDisplayName: string,
  surfaces: readonly HarnessSurfaceSnapshot[],
): string {
  if (surfaces.length === 0) return targetDisplayName;
  if (
    surfaces.length === 2 &&
    surfaces[0]?.id === "antigravity-cli" &&
    surfaces[1]?.id === "antigravity-ide"
  ) {
    return "Antigravity (AGY CLI + IDE)";
  }
  if (surfaces.length === 1)
    return surfaces[0]?.displayName ?? targetDisplayName;
  return surfaces.map(({ displayName }) => displayName).join(" + ");
}

function uniqueTargetExecutables(
  surfaces: readonly HarnessSurfaceSnapshot[],
): readonly DetectedExecutable[] {
  return uniqueExecutables(surfaces.flatMap(({ executables }) => executables));
}

export async function detectHarnesses(
  options: DetectHarnessesOptions,
): Promise<HarnessDetectionSnapshot> {
  const homeDirectory = options.resolveHomeDirectory();
  const surfaces: HarnessSurfaceSnapshot[] = [];
  let agyIdentities = new Set<string>();

  for (const definition of harnessSurfaceCatalog) {
    let executables = await detectSurfaceExecutables(
      definition.executableCandidates,
      options.resolveExecutable,
    );
    if (definition.id === "antigravity-cli") {
      agyIdentities = new Set(
        executables.map(({ identity }) => executableIdentityKey(identity)),
      );
    } else if (definition.id === "antigravity-ide") {
      const legacyAliases = executables.filter(
        ({ legacyAliasFor }) => legacyAliasFor === "agy",
      );
      executables = Object.freeze(
        executables.filter(
          ({ identity, legacyAliasFor }) =>
            legacyAliasFor !== "agy" &&
            !agyIdentities.has(executableIdentityKey(identity)),
        ),
      );
      if (legacyAliases.length > 0) {
        const cliIndex = surfaces.findIndex(
          ({ id }) => id === "antigravity-cli",
        );
        const cli = surfaces[cliIndex];
        if (cli !== undefined) {
          const cliExecutables = uniqueExecutables([
            ...cli.executables,
            ...legacyAliases,
          ]);
          surfaces[cliIndex] = Object.freeze({
            ...cli,
            evidence: "installed",
            executables: cliExecutables,
          });
          agyIdentities = new Set(
            cliExecutables.map(({ identity }) =>
              executableIdentityKey(identity),
            ),
          );
        }
      }
    }
    surfaces.push(
      Object.freeze({
        id: definition.id,
        displayName: definition.displayName,
        targetId: definition.targetId,
        evidence: executables.length === 0 ? "absent" : "installed",
        executables,
      }),
    );
  }

  const targets: ConfigurationTargetSnapshot[] = [];
  for (const definition of configurationTargetCatalog) {
    const installedSurfaces = surfaces.filter(
      ({ evidence, targetId }) =>
        targetId === definition.id && evidence === "installed",
    );
    const targetExecutables = uniqueTargetExecutables(installedSurfaces);
    const configuration = await options.configEvidenceProbes[definition.id]({
      homeDirectory,
      targetId: definition.id,
      executables: targetExecutables,
    });
    const evidence =
      configuration.kind === "blocked"
        ? "blocked"
        : installedSurfaces.length > 0
          ? "installed"
          : configuration.kind === "present"
            ? "configuration-only"
            : "absent";
    targets.push(
      Object.freeze({
        id: definition.id,
        displayName: displayNameForTarget(
          definition.displayName,
          installedSurfaces,
        ),
        surfaceIds: Object.freeze(installedSurfaces.map(({ id }) => id)),
        evidence,
        executables: targetExecutables,
        configuration: Object.freeze({ ...configuration }),
        eligible: evidence === "installed" || evidence === "configuration-only",
        mayCreateConfiguration: evidence === "installed",
        reloadHint: definition.reloadHint,
      }),
    );
  }

  return Object.freeze({
    homeDirectory,
    surfaces: Object.freeze(surfaces),
    targets: Object.freeze(targets),
  });
}
