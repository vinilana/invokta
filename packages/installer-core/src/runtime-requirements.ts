import { isAbsolute } from "node:path";

import type {
  ExecutableEvidence,
  ExecutableResolver,
} from "./harness-detection.js";
import type { SuspendedDescriptor } from "./installer-state.js";
import type { InstallerAction } from "./ownership-planner.js";
import type { InstallerEnvironment } from "./target-config-evidence.js";

export interface RuntimeCommandEvidence {
  readonly declared: string;
  readonly resolved: string;
}

export type RuntimeRequirementsResult =
  | {
      readonly kind: "ready";
      readonly command?: RuntimeCommandEvidence;
      readonly requiredEnvironmentNames: readonly string[];
    }
  | {
      readonly kind: "blocked";
      readonly code: "COMMAND_NOT_FOUND";
      readonly declaredCommand: string;
      readonly requiredEnvironmentNames: readonly string[];
    }
  | {
      readonly kind: "blocked";
      readonly code: "REQUIRED_ENV_MISSING";
      readonly command?: RuntimeCommandEvidence;
      readonly requiredEnvironmentNames: readonly string[];
      readonly missingEnvironmentNames: readonly string[];
    };

export interface ResolveRuntimeRequirementsOptions {
  readonly action: InstallerAction;
  readonly descriptor: SuspendedDescriptor;
  readonly resolveExecutable: ExecutableResolver;
  readonly environment: InstallerEnvironment;
}

const noRuntimeRequirements = Object.freeze({
  kind: "ready" as const,
  requiredEnvironmentNames: Object.freeze([] as string[]),
});

function requiredEnvironmentNames(
  descriptor: SuspendedDescriptor,
): readonly string[] {
  const transport = descriptor.transport;
  if (transport.type === "stdio") {
    return Object.freeze([...new Set(transport.forwardEnv)]);
  }
  const names = [
    ...(transport.authentication.type === "bearer-env"
      ? [transport.authentication.variable]
      : []),
    ...Object.values(transport.headersFromEnv),
  ];
  return Object.freeze([...new Set(names)]);
}

function resolvedExecutablePath(
  evidence: ExecutableEvidence | undefined,
): string | undefined {
  if (evidence === undefined) return undefined;
  try {
    const lookupPath = evidence.path;
    const identity = evidence.identity;
    const realPath = identity.realPath;
    if (
      typeof lookupPath !== "string" ||
      !isAbsolute(lookupPath) ||
      lookupPath.includes("\0") ||
      typeof identity !== "object" ||
      identity === null ||
      typeof realPath !== "string" ||
      !isAbsolute(realPath) ||
      realPath.includes("\0")
    ) {
      return undefined;
    }
    return realPath;
  } catch {
    return undefined;
  }
}

async function resolveCommand(
  command: string,
  resolveExecutable: ExecutableResolver,
): Promise<RuntimeCommandEvidence | undefined> {
  let evidence: ExecutableEvidence | undefined;
  try {
    evidence = await resolveExecutable(command);
  } catch {
    return undefined;
  }
  const resolved = resolvedExecutablePath(evidence);
  return resolved === undefined
    ? undefined
    : Object.freeze({ declared: command, resolved });
}

function environmentVariableIsPresent(
  environment: InstallerEnvironment,
  name: string,
): boolean {
  try {
    const value = environment.get(name);
    return typeof value === "string" && value.length > 0;
  } catch {
    return false;
  }
}

export async function resolveRuntimeRequirements(
  options: ResolveRuntimeRequirementsOptions,
): Promise<RuntimeRequirementsResult> {
  if (options.action === "disable" || options.action === "adopt") {
    return noRuntimeRequirements;
  }

  const requiredNames = requiredEnvironmentNames(options.descriptor);
  const transport = options.descriptor.transport;
  let command: RuntimeCommandEvidence | undefined;
  if (transport.type === "stdio") {
    command = await resolveCommand(
      transport.command,
      options.resolveExecutable,
    );
    if (command === undefined) {
      return Object.freeze({
        kind: "blocked",
        code: "COMMAND_NOT_FOUND",
        declaredCommand: transport.command,
        requiredEnvironmentNames: requiredNames,
      });
    }
  }

  const missingNames = Object.freeze(
    requiredNames.filter(
      (name) => !environmentVariableIsPresent(options.environment, name),
    ),
  );
  if (missingNames.length > 0) {
    return Object.freeze({
      kind: "blocked",
      code: "REQUIRED_ENV_MISSING",
      ...(command === undefined ? {} : { command }),
      requiredEnvironmentNames: requiredNames,
      missingEnvironmentNames: missingNames,
    });
  }
  return Object.freeze({
    kind: "ready",
    ...(command === undefined ? {} : { command }),
    requiredEnvironmentNames: requiredNames,
  });
}
