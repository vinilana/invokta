import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CapabilityDescription,
  CapabilitySummary,
  InvokeOptions,
} from "@invokta/core";
import { isComposedCapabilities } from "@invokta/core";

import { asRecord } from "./diagnostics.js";

/**
 * The structural engine surface the devtools operates on. Loading is dynamic,
 * so the concrete `Engine<Capabilities>` type parameter is unavailable; the
 * public method surface is the contract.
 */
export interface LoadedEngine {
  readonly name: string;
  readonly version: string;
  invoke(
    capabilityId: string,
    input: unknown,
    options?: InvokeOptions,
  ): Promise<unknown>;
  list(): ReadonlyArray<CapabilitySummary>;
  describe(capabilityId: string): CapabilityDescription;
}

export type LoadEngineResult =
  | {
      readonly kind: "loaded";
      readonly engine: LoadedEngine;
      readonly namespace: object;
    }
  | { readonly kind: "load-failed"; readonly error: unknown }
  | { readonly kind: "export-missing" }
  | { readonly kind: "not-an-engine" };

export interface LoadEngineOptions {
  readonly moduleSpecifier: string;
  readonly exportName: string;
  readonly cwd: string;
}

function readExport(
  namespace: object,
  exportName: string,
): { readonly found: boolean; readonly value: unknown } {
  try {
    if (!Object.hasOwn(namespace, exportName)) {
      return { found: false, value: undefined };
    }
    return {
      found: true,
      value: (namespace as Readonly<Record<string, unknown>>)[exportName],
    };
  } catch {
    // An uninitialized binding is indistinguishable from an absent one here,
    // and both are an unusable build input.
    return { found: false, value: undefined };
  }
}

function isEngineLike(value: unknown): value is LoadedEngine {
  try {
    const record = asRecord(value);
    if (record === undefined) return false;
    return (
      typeof record.name === "string" &&
      typeof record.version === "string" &&
      typeof record.invoke === "function" &&
      typeof record.list === "function" &&
      typeof record.describe === "function"
    );
  } catch {
    return false;
  }
}

/** Whether the module also exposes a tracked composed `capabilities` export. */
export function hasComposedCapabilitiesExport(namespace: object): boolean {
  try {
    if (!Object.hasOwn(namespace, "capabilities")) return false;
    return isComposedCapabilities(
      (namespace as Readonly<Record<string, unknown>>).capabilities,
    );
  } catch {
    return false;
  }
}

export async function loadEngineModule(
  options: LoadEngineOptions,
): Promise<LoadEngineResult> {
  // A bare relative specifier would resolve against this package rather than
  // the application being inspected, so it becomes an explicit file URL first.
  const moduleUrl = pathToFileURL(
    resolve(options.cwd, options.moduleSpecifier),
  );

  let namespace: object;
  try {
    namespace = (await import(moduleUrl.href)) as object;
  } catch (error) {
    return { kind: "load-failed", error };
  }

  const selected = readExport(namespace, options.exportName);
  if (!selected.found) return { kind: "export-missing" };
  if (!isEngineLike(selected.value)) return { kind: "not-an-engine" };
  return { kind: "loaded", engine: selected.value, namespace };
}
