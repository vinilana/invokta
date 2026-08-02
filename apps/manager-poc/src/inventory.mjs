/**
 * Builds the read model the console renders: one row per Action Engine, one
 * column per supported MCP configuration target, and one cell per pair.
 *
 * The cell is the whole point of the console. Today an operator has to run
 * `invokta-installer status` to learn where an engine is registered, and there
 * is no view at all of where it could be registered. The matrix answers both
 * questions in the same place, which also makes "install" a concrete gesture:
 * clicking an empty cell.
 */

import { discoverEngineProjects } from "./engine-discovery.mjs";

function projectDescriptor(project) {
  if (!project.valid || project.entrypointPath === undefined) return undefined;
  return {
    id: project.id,
    version: project.version,
    title: project.title,
    description: project.description,
    capabilityIds: project.capabilityIds,
    server: {
      name: project.serverName,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [project.entrypointPath],
        forwardEnv: project.forwardEnv,
      },
    },
  };
}

function persistedDescriptor(installation) {
  if (installation.launchDescriptor === undefined) return undefined;
  return {
    id: installation.entryId,
    version: installation.registryVersion,
    title: installation.serverName,
    description: `Managed ${installation.serverName} MCP server.`,
    capabilityIds: [installation.entryId],
    server: installation.launchDescriptor,
  };
}

function describeTarget(target) {
  return {
    id: target.id,
    displayName: target.displayName,
    evidence: target.evidence,
    eligible: target.eligible,
    mayCreateConfiguration: target.mayCreateConfiguration,
    reloadHint: target.reloadHint,
    surfaces: [...target.surfaceIds],
    configuration:
      target.configuration.kind === "blocked"
        ? { kind: "blocked", code: target.configuration.code }
        : { kind: "present", path: target.configuration.path },
  };
}

function emptyCell(target, descriptor, bridge, project) {
  if (target.configuration.kind === "blocked") {
    return {
      state: "unavailable",
      reason: bridge.describeCode(target.configuration.code),
    };
  }
  if (descriptor === undefined) {
    return {
      state: "unavailable",
      reason:
        "No launch descriptor is available for this engine. Reinstall it from its project directory.",
    };
  }
  const compatibility = bridge.supports(target.id, descriptor);
  if (!compatibility.supported) {
    return { state: "unavailable", reason: compatibility.reason };
  }
  if (!target.eligible) {
    return {
      state: "unavailable",
      reason:
        "This client is not installed and has no user configuration to write into.",
    };
  }
  if (project !== undefined && !project.entrypointBuilt) {
    return {
      state: "needs-build",
      reason: "Build the project before installing it here.",
    };
  }
  return { state: "installable" };
}

function managedCell(view) {
  const installation = view.installation;
  return {
    state: "managed",
    status: view.status,
    actions: [...view.actions],
    unavailableCode: view.unavailableCode,
    serverName: installation.serverName,
    configPath: installation.configPath,
    adopted: installation.adopted,
    installedAt: installation.installedAt,
    updatedAt: installation.updatedAt,
    transport: installation.launchDescriptor?.transport,
  };
}

/**
 * Merges three sources of truth:
 *
 * 1. installer state, re-inspected against the configuration on disk;
 * 2. `invokta.mcp.json` manifests found on disk; and
 * 3. the detected configuration target catalog.
 */
export async function buildInventory(bridge, scanRoots) {
  const [views, discovery] = await Promise.all([
    bridge.inspectManaged(),
    discoverEngineProjects(scanRoots),
  ]);
  const snapshot = bridge.snapshot;
  const targets = snapshot.targets.map(describeTarget);
  const engines = new Map();

  const upsert = (id) => {
    const existing = engines.get(id);
    if (existing !== undefined) return existing;
    const created = {
      id,
      title: id,
      version: "",
      description: "",
      serverName: id,
      capabilityIds: [],
      project: undefined,
      descriptorSource: "none",
      cells: {},
    };
    engines.set(id, created);
    return created;
  };

  for (const project of discovery.projects) {
    if (!project.valid) continue;
    const engine = upsert(project.id);
    engine.title = project.title;
    engine.version = project.version;
    engine.description = project.description;
    engine.serverName = project.serverName;
    engine.capabilityIds = project.capabilityIds;
    engine.descriptorSource = "project";
    engine.project = {
      directory: project.projectDirectory,
      manifestPath: project.manifestPath,
      entrypoint: project.entrypoint,
      entrypointPath: project.entrypointPath,
      entrypointBuilt: project.entrypointBuilt,
      forwardEnv: project.forwardEnv,
    };
    engine.descriptor = projectDescriptor(project);
  }

  for (const view of views) {
    const engine = upsert(view.installation.entryId);
    engine.cells[view.installation.targetId] = managedCell(view);
    if (engine.descriptor === undefined) {
      const descriptor = persistedDescriptor(view.installation);
      if (descriptor !== undefined) {
        engine.descriptor = descriptor;
        engine.descriptorSource = "state";
        engine.serverName = view.installation.serverName;
        engine.version = view.installation.registryVersion;
      }
    }
  }

  for (const engine of engines.values()) {
    for (const target of snapshot.targets) {
      if (engine.cells[target.id] !== undefined) continue;
      engine.cells[target.id] = emptyCell(
        target,
        engine.descriptor,
        bridge,
        engine.project,
      );
    }
  }

  const rows = [...engines.values()]
    .map((engine) => {
      const { descriptor, ...rest } = engine;
      return {
        ...rest,
        installedCount: Object.values(engine.cells).filter(
          (cell) => cell.state === "managed",
        ).length,
        hasDescriptor: descriptor !== undefined,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    generatedAt: new Date().toISOString(),
    homeDirectory: snapshot.homeDirectory,
    discovery: {
      roots: discovery.roots,
      inspected: discovery.inspected,
      truncated: discovery.truncated,
      invalid: discovery.projects
        .filter((project) => !project.valid)
        .map((project) => ({
          manifestPath: project.manifestPath,
          reason: project.reason,
        })),
    },
    targets,
    engines: rows,
    /** Kept out of the HTTP payload; the action handler needs the descriptors. */
    descriptors: new Map(
      [...engines.values()]
        .filter((engine) => engine.descriptor !== undefined)
        .map((engine) => [engine.id, engine]),
    ),
  };
}
