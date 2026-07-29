import { detectHarnesses } from "../../dist/harness-detection.js";
import { createNodeExecutableResolver } from "../../dist/node-harness-environment.js";
import { createNodeFileSystem } from "../../dist/node-file-system.js";
import {
  createNodeTargetConfigEvidenceProbes,
  createProcessInstallerEnvironment,
} from "../../dist/target-config-evidence.js";

const homeDirectory = process.env.INVOKTA_INSTALLER_TEST_HOME;
if (homeDirectory === undefined) {
  throw new Error("INVOKTA_INSTALLER_TEST_HOME is required.");
}
const snapshot = await detectHarnesses({
  resolveHomeDirectory: () => homeDirectory,
  resolveExecutable: createNodeExecutableResolver(),
  configEvidenceProbes: createNodeTargetConfigEvidenceProbes({
    environment: createProcessInstallerEnvironment(),
    fileSystem: createNodeFileSystem(),
  }),
});

process.stdout.write(
  `${JSON.stringify({
    installedSurfaces: snapshot.surfaces
      .filter(({ evidence }) => evidence === "installed")
      .map(({ id }) => id),
    eligibleTargets: snapshot.targets
      .filter(({ eligible }) => eligible)
      .map(({ id }) => id),
    configurationOnlyTargets: snapshot.targets
      .filter(({ evidence }) => evidence === "configuration-only")
      .map(({ id }) => id),
    creationTargets: snapshot.targets
      .filter(({ mayCreateConfiguration }) => mayCreateConfiguration)
      .map(({ id }) => id),
  })}\n`,
);
