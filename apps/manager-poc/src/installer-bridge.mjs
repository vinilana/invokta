/**
 * Proof-of-concept bridge to the built `@invokta/installer` package.
 *
 * The installer publishes no import API on purpose: ADR 0010 states that it is
 * a binary-only application with no public programmatic mutation API, and its
 * package manifest declares `"exports": {}`. This file deliberately imports the
 * built modules by path so the proof of concept can reuse the reviewed
 * detection, ownership, and transaction code instead of duplicating eleven
 * client adapters and four configuration formats.
 *
 * Everything imported below is the exact surface a productized manager needs.
 * Promoting it to a supported contract requires an architecture decision; see
 * ../README.md for the two candidate shapes.
 */

import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";

const installerDistUrl = new URL(
  "../../../packages/installer/dist/",
  import.meta.url,
);

const buildHint =
  'The built installer was not found. Run "yarn build" at the repository root first.';

async function loadInstallerModule(name) {
  const moduleUrl = new URL(`${name}.js`, installerDistUrl);
  try {
    return await import(moduleUrl.href);
  } catch (cause) {
    throw new Error(`${buildHint} (missing ${name}.js)`, { cause });
  }
}

async function assertInstallerIsBuilt() {
  try {
    await access(new URL("cli.js", installerDistUrl));
  } catch (cause) {
    throw new Error(buildHint, { cause });
  }
}

function createMutationDependencies(modules, fileSystem, environment) {
  return {
    adapters: modules.targetAdapters.configurationTargetAdapters,
    currentUserId: process.getuid?.() ?? -1,
    environment,
    fileSystem,
    lock: {
      clock: {
        monotonicNow: () => performance.now(),
        now: () => Date.now(),
        wait: (milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)),
      },
      processId: process.pid,
      randomBytes: (length) => randomBytes(length),
    },
    now: () => new Date().toISOString(),
  };
}

/**
 * Loads the installer modules once and exposes the read and mutation
 * operations the console needs. Detection is re-run on demand because
 * installing an engine can create a client configuration file.
 */
export async function createInstallerBridge() {
  await assertInstallerIsBuilt();

  const [
    engineManifest,
    harnessDetection,
    installerError,
    managedInstallations,
    mutationCoordinator,
    nodeFileSystem,
    nodeHarnessEnvironment,
    registry,
    targetAdapters,
    targetConfigEvidence,
  ] = await Promise.all([
    loadInstallerModule("engine-manifest"),
    loadInstallerModule("harness-detection"),
    loadInstallerModule("installer-error"),
    loadInstallerModule("managed-installations"),
    loadInstallerModule("mutation-coordinator"),
    loadInstallerModule("node-file-system"),
    loadInstallerModule("node-harness-environment"),
    loadInstallerModule("registry"),
    loadInstallerModule("target-adapters"),
    loadInstallerModule("target-config-evidence"),
  ]);

  const modules = { targetAdapters };
  const fileSystem = nodeFileSystem.createNodeFileSystem();
  const environment = targetConfigEvidence.createProcessInstallerEnvironment();
  const resolveExecutable =
    nodeHarnessEnvironment.createNodeExecutableResolver();
  const dependencies = createMutationDependencies(
    modules,
    fileSystem,
    environment,
  );
  const bundledRegistry = await registry.loadBundledRegistry(
    fileSystem,
    targetAdapters.registryCompatibilityAdapters,
  );

  let snapshot = await harnessDetection.detectHarnesses({
    resolveHomeDirectory: nodeHarnessEnvironment.resolveNodeOperatingSystemHome,
    resolveExecutable,
    configEvidenceProbes:
      targetConfigEvidence.createNodeTargetConfigEvidenceProbes({
        environment,
        fileSystem,
      }),
  });

  return {
    get snapshot() {
      return snapshot;
    },

    /** Stable diagnostic text for an installer error code. */
    describeCode(code) {
      return installerError.installerErrorMessages[code] ?? code;
    },

    /** True when the target adapter accepts this descriptor shape. */
    supports(targetId, descriptor) {
      return targetAdapters.configurationTargetAdapters[targetId].compatibility(
        descriptor,
      );
    },

    async redetect() {
      snapshot = await harnessDetection.detectHarnesses({
        resolveHomeDirectory:
          nodeHarnessEnvironment.resolveNodeOperatingSystemHome,
        resolveExecutable,
        configEvidenceProbes:
          targetConfigEvidence.createNodeTargetConfigEvidenceProbes({
            environment,
            fileSystem,
          }),
      });
      return snapshot;
    },

    /**
     * Every installer-owned registration, re-inspected against the client
     * configuration that is on disk right now. This is the read model the
     * console renders; it performs no write.
     */
    async inspectManaged() {
      return managedInstallations.inspectManagedInstallations({
        dependencies,
        registry: bundledRegistry,
        snapshot,
      });
    },

    /**
     * Validates a project directory through the installer's own manifest,
     * ownership, and entry-point rules and returns the launch descriptor it
     * would install.
     */
    async resolveProjectDescriptor(projectDirectory) {
      const source = await engineManifest.loadEngineInstallManifest({
        currentUserId: dependencies.currentUserId,
        fileSystem,
        nodeExecutable: process.execPath,
        projectDirectory,
      });
      return source.descriptor;
    },

    /**
     * Runs one installer transaction per target through the reviewed
     * coordinator: shared state lock, target lock, revalidation, atomic
     * configuration commit, atomic state commit, rollback on failure.
     */
    async apply({ action, descriptor, targetIds }) {
      return mutationCoordinator.mutateDescriptorAcrossTargets({
        action,
        dependencies,
        descriptor,
        snapshot,
        targetIds,
      });
    },
  };
}
