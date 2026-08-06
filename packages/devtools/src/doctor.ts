import { asRecord } from "./diagnostics.js";
import type { LoadedEngine } from "./load-engine.js";

export type DoctorFinding =
  | { readonly code: "LIST_UNREADABLE"; readonly error?: unknown }
  | {
      readonly code: "DESCRIBE_FAILED";
      readonly capabilityId: string;
      readonly error?: unknown;
    }
  | {
      readonly code: "SCHEMA_UNREADABLE";
      readonly capabilityId: string;
      readonly schema: "input" | "output";
    };

export type DoctorNote =
  | { readonly code: "TITLE_MISSING"; readonly capabilityId: string }
  | { readonly code: "ANNOTATIONS_MISSING"; readonly capabilityId: string }
  | { readonly code: "MCP_MANIFEST_PRESENT" }
  | { readonly code: "MCP_MANIFEST_MISSING" }
  | { readonly code: "COMPOSITION_CHECK_AVAILABLE" };

export interface DoctorReport {
  readonly engineName: string;
  readonly engineVersion: string;
  /** Absent when the capability list itself could not be read. */
  readonly capabilityCount?: number;
  readonly findings: readonly DoctorFinding[];
  readonly notes: readonly DoctorNote[];
}

export interface InspectEngineOptions {
  /** Presence of `invokta.mcp.json` next to the inspected project, when known. */
  readonly mcpManifestPresent?: boolean;
  /** Whether the module also exposes a tracked composed `capabilities` export. */
  readonly composedCapabilitiesExport?: boolean;
}

function isObjectSchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runs the read-only doctor checks against a loaded engine. The inspection
 * reads `list` and `describe` only; it never invokes a capability, starts a
 * transport, or touches the filesystem. Filesystem-derived facts arrive
 * through the options so the inspection stays pure and reusable.
 */
export function inspectEngine(
  engine: LoadedEngine,
  options: InspectEngineOptions = {},
): DoctorReport {
  const findings: DoctorFinding[] = [];
  const notes: DoctorNote[] = [];

  let summaries: readonly unknown[] | undefined;
  try {
    const listed: unknown = engine.list();
    if (Array.isArray(listed)) {
      summaries = listed;
    } else {
      findings.push({ code: "LIST_UNREADABLE" });
    }
  } catch (error) {
    findings.push({ code: "LIST_UNREADABLE", error });
  }

  for (const summary of summaries ?? []) {
    const capabilityId = asRecord(summary)?.id;
    if (typeof capabilityId !== "string") {
      findings.push({ code: "DESCRIBE_FAILED", capabilityId: "<unreadable>" });
      continue;
    }

    let description: unknown;
    try {
      description = engine.describe(capabilityId);
    } catch (error) {
      findings.push({ code: "DESCRIBE_FAILED", capabilityId, error });
      continue;
    }

    const record = asRecord(description);
    if (!isObjectSchema(record?.inputSchema)) {
      findings.push({
        code: "SCHEMA_UNREADABLE",
        capabilityId,
        schema: "input",
      });
    }
    if (!isObjectSchema(record?.outputSchema)) {
      findings.push({
        code: "SCHEMA_UNREADABLE",
        capabilityId,
        schema: "output",
      });
    }
    if (record?.title === undefined) {
      notes.push({ code: "TITLE_MISSING", capabilityId });
    }
    if (record?.annotations === undefined) {
      notes.push({ code: "ANNOTATIONS_MISSING", capabilityId });
    }
  }

  if (options.mcpManifestPresent !== undefined) {
    notes.push({
      code: options.mcpManifestPresent
        ? "MCP_MANIFEST_PRESENT"
        : "MCP_MANIFEST_MISSING",
    });
  }
  if (options.composedCapabilitiesExport === true) {
    notes.push({ code: "COMPOSITION_CHECK_AVAILABLE" });
  }

  return {
    engineName: engine.name,
    engineVersion: engine.version,
    ...(summaries === undefined ? {} : { capabilityCount: summaries.length }),
    findings,
    notes,
  };
}
