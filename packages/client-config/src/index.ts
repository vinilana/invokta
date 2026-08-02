/**
 * Public API of the Invokta installer core.
 *
 * This package owns harness detection, the finite configuration target
 * catalog, the format-preserving client adapters, engine manifests, path
 * identity, ownership planning, installer state, locking, and the
 * transaction coordinator. `@invokta/installer` and `@invokta/console` are
 * adapters over this surface; the boundary is defined by ADR 0019.
 */

export type {
  DiscoverEngineProjectsOptions,
  EngineProjectDiscovery,
  RejectedEngineProject,
} from "./engine-discovery.js";
export {
  defaultDiscoveryDepth,
  defaultDiscoveryDirectoryLimit,
  discoverEngineProjects,
  engineManifestFileName,
} from "./engine-discovery.js";
export type {
  BuildEngineInventoryOptions,
  EngineDescriptorSource,
  EngineInventory,
  EngineInventoryBlockedReason,
  EngineInventoryCell,
  EngineInventoryRow,
} from "./engine-inventory.js";
export {
  buildEngineInventory,
  managedDescriptorFor,
  persistedInstallDescriptorFor,
} from "./engine-inventory.js";
export type {
  EngineInstallSource,
  EngineProjectMetadata,
  EngineRemovalSource,
  LoadEngineInstallManifestOptions,
  LoadEngineRemovalManifestOptions,
  ValidatedEngineManifest,
} from "./engine-manifest.js";
export {
  loadEngineInstallManifest,
  loadEngineProjectMetadata,
  loadEngineRemovalManifest,
  validateEngineInstallManifestBytes,
} from "./engine-manifest.js";
export type {
  InstallerDirectoryEntry,
  InstallerDirectoryReader,
  InstallerFileKind,
  InstallerFileStat,
  InstallerFileSystem,
  InstallerFileSystemErrorCode,
  InstallerNoFollowPathInspection,
  InstallerPathInspection,
  InstallerReadHandle,
  InstallerTransactionFileSystem,
  InstallerWriteHandle,
} from "./file-system.js";
export {
  InstallerFileSystemError,
  isInstallerFileSystemError,
  maximumInstallerFileBytes,
} from "./file-system.js";
export type {
  ConfigurationTargetDefinition,
  HarnessSurfaceDefinition,
  HarnessSurfaceId,
} from "./harness-catalog.js";
export {
  configurationTargetCatalog,
  harnessSurfaceCatalog,
} from "./harness-catalog.js";
export type {
  ConfigurationTargetSnapshot,
  DetectedExecutable,
  DetectHarnessesOptions,
  ExecutableEvidence,
  ExecutableIdentity,
  ExecutableResolver,
  HarnessDetectionSnapshot,
  HarnessSurfaceSnapshot,
  OperatingSystemHomeResolver,
  TargetConfigEvidence,
  TargetConfigEvidenceCode,
  TargetConfigEvidenceContext,
  TargetConfigEvidenceProbe,
  TargetConfigEvidenceProbes,
} from "./harness-detection.js";
export { detectHarnesses } from "./harness-detection.js";
export type { InstallerErrorCode } from "./installer-error.js";
export {
  InstallerError,
  installerErrorMessages,
  renderInstallerDiagnostic,
} from "./installer-error.js";
export type {
  AcquireInstallerLocksInput,
  InstallerLockClock,
  InstallerLockDependencies,
  OwnedInstallerLocks,
} from "./installer-lock.js";
export {
  acquireInstallerLocks,
  configLockPath,
  stateLockPath,
} from "./installer-lock.js";
export type {
  InstallerState,
  InstallerStateValidationResult,
  LoadedInstallerState,
  LoadInstallerStateOptions,
  ManagedInstallation,
  StateIssue,
  StateIssueCode,
  StateTargetContract,
  StateTargetContracts,
  SuspendedDescriptor,
} from "./installer-state.js";
export {
  createEmptyInstallerState,
  installationKey,
  isInstallerTimestampAfter,
  loadInstallerState,
  validateInstallerStateBytes,
} from "./installer-state.js";
export type {
  ApplyInstallerStatePlanInput,
  InstallerStateWriteTransition,
} from "./installer-state-transition.js";
export {
  applyInstallerStatePlan,
  serializeInstallerState,
} from "./installer-state-transition.js";
export type { ToggleStrategy } from "./jcs-fingerprint.js";
export {
  canonicalizeJcs,
  fingerprintNormalizedDefinition,
  registerCanonicalJcs,
} from "./jcs-fingerprint.js";
export {
  createJsonTargetAdapter,
  jsonDefinition,
} from "./json-target-adapter.js";
export {
  createJson5TargetAdapter,
  json5Definition,
} from "./json5-target-adapter.js";
export type {
  InspectEngineManagedInstallationsOptions,
  InspectManagedInstallationsOptions,
  ManagedInstallationView,
} from "./managed-installations.js";
export {
  inspectEngineManagedInstallations,
  inspectManagedInstallations,
} from "./managed-installations.js";
export type {
  InstallDescriptorAcrossTargetsInput,
  MutateDescriptorAcrossTargetsInput,
  MutationCoordinatorDependencies,
  RemoveEngineDescriptorFromTargetInput,
  TargetMutationResult,
} from "./mutation-coordinator.js";
export {
  buildStateTargetContracts,
  installDescriptorAcrossTargets,
  mutateDescriptorAcrossTargets,
  removeEngineDescriptorFromTarget,
} from "./mutation-coordinator.js";
export type { CreateNodeFileSystemOptions } from "./node-file-system.js";
export { createNodeFileSystem } from "./node-file-system.js";
export type { NodeExecutableResolverOptions } from "./node-harness-environment.js";
export {
  createNodeExecutableResolver,
  resolveNodeOperatingSystemHome,
} from "./node-harness-environment.js";
export type {
  InstallerAction,
  InstallerActionPlan,
  OwnershipPlan,
  OwnershipPlanningInput,
} from "./ownership-planner.js";
export { planInstallerAction, planOwnership } from "./ownership-planner.js";
export type {
  PathContractName,
  PathSafetyContract,
  ResolvePathSafetyContractOptions,
} from "./path-contract.js";
export {
  contractOwnerValid,
  createPosixPathContract,
  createWindowsPathContract,
  ownerAccepted,
  resolvePathSafetyContract,
} from "./path-contract.js";
export type {
  BootstrapPrivateDirectoryOptions,
  CapturePathIdentityOptions,
  CapturePathRootOptions,
  InstallerPathIdentity,
  InstallerPathIdentityErrorCode,
  InstallerPathNodeIdentity,
  InstallerPathRootIdentity,
  InstallerPathRootKind,
  InstallerPathTargetKind,
} from "./path-identity.js";
export {
  bootstrapPrivateDirectory,
  capturePathIdentity,
  capturePathRoot,
  InstallerPathIdentityError,
  revalidatePathIdentity,
} from "./path-identity.js";
export type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
  RegistryCompatibility,
  RegistryCompatibilityAdapter,
  RegistryCompatibilityAdapters,
  RegistryIssue,
  RegistryIssueCode,
  RegistryValidationCounters,
  RegistryValidationResult,
  StdioTransport,
  StreamableHttpTransport,
  ValidatedRegistry,
  ValidatedRegistryEntry,
} from "./registry.js";
export {
  bundledRegistryUrl,
  configurationTargetIds,
  loadBundledRegistry,
  validateRegistryBytes,
} from "./registry.js";
export type { CreateRemoteInstallDescriptorOptions } from "./remote-install-source.js";
export { createRemoteInstallDescriptor } from "./remote-install-source.js";
export type {
  ResolveRuntimeRequirementsOptions,
  RuntimeCommandEvidence,
  RuntimeRequirementsResult,
} from "./runtime-requirements.js";
export { resolveRuntimeRequirements } from "./runtime-requirements.js";
export type {
  CurrentTargetServer,
  DecodedTargetSource,
  InspectedJsonRecord,
  InspectedJsonValue,
  TargetAdapter,
  TargetAdapterCounters,
  TargetAdapterMetadata,
  TargetConfigInspection,
  TargetDefinitionCanonicals,
  TargetPatch,
  TargetPatchRequest,
} from "./target-adapter.js";
export {
  assertPostImageDefinition,
  assertServerName,
  assertTargetInspectionConsistency,
  createTargetAdapterCounters,
  decodeTargetSource,
  encodeTargetPostImage,
  finalizeInspectedMcpDefinition,
  freezeDefinition,
  freezeDetachedDefinition,
  frozenTargetInspection,
  inspectedJsonArray,
  inspectedJsonRecord,
  inspectedJsonScalar,
  inspectionPass,
  normalizedCurrentDefinition,
  normalizedDetachedDefinition,
  normalizedMcpDefinition,
  parsePass,
  patchPass,
  readOwn,
  requireRecord,
  targetConfigByteLimit,
  targetDefinitionCanonicals,
  targetInspectionState,
  targetInspectionStateFor,
  unsupportedDefinition,
} from "./target-adapter.js";
export {
  configurationTargetAdapters,
  openClawDeniedEnvironmentNameSnapshot,
  openClawEnvironmentPolicyCommit,
  registryCompatibilityAdapters,
} from "./target-adapters.js";
export type {
  CreateNodeTargetConfigEvidenceProbesOptions,
  InstallerEnvironment,
} from "./target-config-evidence.js";
export {
  createNodeTargetConfigEvidenceProbes,
  createProcessInstallerEnvironment,
} from "./target-config-evidence.js";
export {
  createTomlTargetAdapter,
  tomlDefinition,
} from "./toml-target-adapter.js";
export {
  createYamlTargetAdapter,
  yamlDefinition,
} from "./yaml-target-adapter.js";
