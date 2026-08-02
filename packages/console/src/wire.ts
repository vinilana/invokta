/**
 * The exact shape the console page receives.
 *
 * Projecting explicitly, instead of serializing the core model, keeps the
 * response free of everything the page has no use for: device and inode
 * identities, client executable paths, ownership fingerprints, and anything
 * that could carry an environment value. What remains is what the operator
 * already sees in their own configuration files.
 */

import type {
  ConsoleDiscoveryReport,
  ConsoleInventory,
} from "./console-service.js";

export interface WireTarget {
  readonly id: string;
  readonly displayName: string;
  readonly evidence: string;
  readonly eligible: boolean;
  readonly reloadHint: string;
  readonly surfaces: readonly string[];
  readonly configuration:
    | { readonly kind: "blocked"; readonly code: string }
    | { readonly kind: "present" | "absent"; readonly path: string };
}

export interface WireCell {
  readonly state: "managed" | "installable" | "needs-build" | "unavailable";
  readonly status?: string;
  readonly actions?: readonly string[];
  readonly unavailableCode?: string;
  readonly reason?: Readonly<Record<string, string>>;
  readonly serverName?: string;
  readonly configPath?: string;
  readonly adopted?: boolean;
  readonly installedAt?: string;
  readonly updatedAt?: string;
  readonly transport?: Readonly<Record<string, unknown>>;
}

/** What an install would write, so the confirmation can state it exactly. */
export type WireInstallPreview =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: readonly string[];
    }
  | { readonly type: "streamable-http"; readonly url: string };

export interface WireEngine {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly description: string;
  readonly serverName: string;
  readonly capabilityIds: readonly string[];
  readonly descriptorSource: string;
  readonly installedCount: number;
  readonly reachableCount: number;
  readonly installPreview?: WireInstallPreview;
  readonly project?: {
    readonly directory: string;
    readonly manifestPath: string;
    readonly entrypoint: string;
    readonly entrypointBuilt: boolean;
    readonly forwardEnv: readonly string[];
  };
  readonly cells: Readonly<Record<string, WireCell>>;
}

export interface WireInventory {
  readonly homeDirectory: string;
  readonly discovery: ConsoleDiscoveryReport;
  readonly targets: readonly WireTarget[];
  readonly engines: readonly WireEngine[];
}

function wireTransport(
  transport: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (transport === undefined) return undefined;
  if (transport.type === "stdio") {
    return Object.freeze({
      type: "stdio",
      command: transport.command,
      args: transport.args,
      forwardEnv: transport.forwardEnv,
    });
  }
  return Object.freeze({
    type: transport.type,
    url: transport.url,
    // Only variable names are ever persisted, never their values.
    authentication: transport.authentication,
    headersFromEnv: transport.headersFromEnv,
  });
}

function installPreviewFor(
  engine: ConsoleInventory["inventory"]["engines"][number],
  nodeExecutable: string,
): WireInstallPreview | undefined {
  if (engine.project !== undefined) {
    return {
      type: "stdio",
      command: nodeExecutable,
      args: [engine.project.entrypointPath],
    };
  }
  for (const cell of Object.values(engine.cells)) {
    if (cell.state !== "managed") continue;
    const transport = cell.installation.launchDescriptor?.transport;
    if (transport === undefined) continue;
    return transport.type === "stdio"
      ? {
          type: "stdio",
          command: transport.command,
          args: [...transport.args],
        }
      : { type: "streamable-http", url: transport.url };
  }
  return undefined;
}

export function toWireInventory(source: ConsoleInventory): WireInventory {
  const targets = source.inventory.targets.map<WireTarget>((target) => ({
    id: target.id,
    displayName: target.displayName,
    evidence: target.evidence,
    eligible: target.eligible,
    reloadHint: target.reloadHint,
    surfaces: [...target.surfaceIds],
    configuration:
      target.configuration.kind === "blocked"
        ? { kind: "blocked", code: target.configuration.code }
        : {
            kind: target.configuration.kind,
            path: target.configuration.path,
          },
  }));

  const engines = source.inventory.engines.map<WireEngine>((engine) => {
    const cells: Record<string, WireCell> = {};
    for (const [targetId, cell] of Object.entries(engine.cells)) {
      if (cell.state === "managed") {
        cells[targetId] = {
          state: "managed",
          status: cell.status,
          actions: [...cell.actions],
          ...(cell.unavailableCode === undefined
            ? {}
            : { unavailableCode: cell.unavailableCode }),
          serverName: cell.installation.serverName,
          configPath: cell.installation.configPath,
          adopted: cell.installation.adopted,
          installedAt: cell.installation.installedAt,
          updatedAt: cell.installation.updatedAt,
          ...(() => {
            const transport = wireTransport(
              cell.installation.launchDescriptor?.transport as
                | Readonly<Record<string, unknown>>
                | undefined,
            );
            return transport === undefined ? {} : { transport };
          })(),
        };
        continue;
      }
      cells[targetId] =
        cell.state === "unavailable"
          ? {
              state: "unavailable",
              reason: Object.freeze(
                Object.fromEntries(
                  Object.entries(cell.reason).map(([key, value]) => [
                    key,
                    String(value),
                  ]),
                ),
              ),
            }
          : { state: cell.state };
    }

    return {
      id: engine.id,
      title: engine.title,
      version: engine.version,
      description: engine.description,
      serverName: engine.serverName,
      capabilityIds: [...engine.capabilityIds],
      descriptorSource: engine.descriptorSource,
      installedCount: engine.installedCount,
      reachableCount: engine.reachableCount,
      ...(() => {
        const preview = installPreviewFor(engine, source.nodeExecutable);
        return preview === undefined ? {} : { installPreview: preview };
      })(),
      ...(engine.project === undefined
        ? {}
        : {
            project: {
              directory: engine.project.projectDirectory,
              manifestPath: engine.project.manifestPath,
              entrypoint: engine.project.manifest.server.entrypoint,
              entrypointBuilt: engine.project.entrypointBuilt,
              forwardEnv: [...engine.project.manifest.server.forwardEnv],
            },
          }),
      cells,
    };
  });

  return {
    homeDirectory: source.homeDirectory,
    discovery: source.discovery,
    targets,
    engines,
  };
}
