import { asRecord, readThrownValueInfo } from "./diagnostics.js";
import type { LoadedEngine } from "./load-engine.js";

/** A one-line remediation shown next to a finding or note when present. */
interface WithHint {
  readonly hint?: string;
}

export type DoctorFinding =
  | ({
      readonly code: "LIST_UNREADABLE";
      readonly error?: unknown;
    } & WithHint)
  | ({
      readonly code: "DESCRIBE_FAILED";
      readonly capabilityId: string;
      readonly error?: unknown;
    } & WithHint)
  | ({
      readonly code: "SCHEMA_UNREADABLE";
      readonly capabilityId: string;
      readonly schema: "input" | "output";
    } & WithHint);

export type DoctorNote =
  | ({
      readonly code: "TITLE_MISSING";
      readonly capabilityId: string;
    } & WithHint)
  | ({
      readonly code: "ANNOTATIONS_MISSING";
      readonly capabilityId: string;
    } & WithHint)
  | ({
      readonly code: "DESCRIPTION_MISSING";
      readonly capabilityId: string;
    } & WithHint)
  | ({
      readonly code: "SCHEMA_WITHOUT_TYPE";
      readonly capabilityId: string;
      readonly schema: "input" | "output";
    } & WithHint)
  | ({
      readonly code: "DUPLICATE_CAPABILITY_ID";
      readonly capabilityId: string;
    } & WithHint)
  | ({ readonly code: "MCP_MANIFEST_PRESENT" } & WithHint)
  | ({ readonly code: "MCP_MANIFEST_MISSING" } & WithHint)
  | ({ readonly code: "COMPOSITION_CHECK_AVAILABLE" } & WithHint);

export interface DoctorReport {
  readonly engineName: string;
  readonly engineVersion: string;
  /** Absent when the capability list itself could not be read. */
  readonly capabilityCount?: number;
  readonly findings: readonly DoctorFinding[];
  readonly notes: readonly DoctorNote[];
}

/**
 * Converts a report into its JSON-safe body: thrown values are reduced to
 * their name, code, and message so no stack, cause, or payload can travel.
 */
export function doctorReportToJson(report: DoctorReport): unknown {
  return {
    engineName: report.engineName,
    engineVersion: report.engineVersion,
    ...(report.capabilityCount === undefined
      ? {}
      : { capabilityCount: report.capabilityCount }),
    findings: report.findings.map((finding) => ({
      ...finding,
      ...("error" in finding && finding.error !== undefined
        ? { error: readThrownValueInfo(finding.error) }
        : {}),
    })),
    notes: report.notes,
  };
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

function checkSchema(
  findings: DoctorFinding[],
  notes: DoctorNote[],
  capabilityId: string,
  schema: "input" | "output",
  value: unknown,
): void {
  if (!isObjectSchema(value)) {
    findings.push({
      code: "SCHEMA_UNREADABLE",
      capabilityId,
      schema,
      hint: "Export inputSchema and outputSchema as JSON Schema objects from describe().",
    });
    return;
  }
  if (!("type" in (value as Readonly<Record<string, unknown>>))) {
    notes.push({
      code: "SCHEMA_WITHOUT_TYPE",
      capabilityId,
      schema,
      hint: 'Declare the schema root "type" (for example "object") so clients can render a form.',
    });
  }
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
      findings.push({
        code: "LIST_UNREADABLE",
        hint: "Return an array of capability summaries with string id fields from list().",
      });
    }
  } catch (error) {
    findings.push({
      code: "LIST_UNREADABLE",
      error,
      hint: "Return an array of capability summaries with string id fields from list().",
    });
  }

  const seenIds = new Set<string>();
  for (const summary of summaries ?? []) {
    const capabilityId = asRecord(summary)?.id;
    if (typeof capabilityId !== "string") {
      findings.push({
        code: "DESCRIBE_FAILED",
        capabilityId: "<unreadable>",
        hint: "Give every capability summary a string id field in list().",
      });
      continue;
    }
    if (seenIds.has(capabilityId)) {
      notes.push({
        code: "DUPLICATE_CAPABILITY_ID",
        capabilityId,
        hint: "Give every capability a unique id; a duplicate id makes describe() ambiguous.",
      });
    }
    seenIds.add(capabilityId);

    let description: unknown;
    try {
      description = engine.describe(capabilityId);
    } catch (error) {
      findings.push({
        code: "DESCRIBE_FAILED",
        capabilityId,
        error,
        hint: "Return the capability description from describe() without throwing.",
      });
      continue;
    }

    const record = asRecord(description);
    checkSchema(findings, notes, capabilityId, "input", record?.inputSchema);
    checkSchema(findings, notes, capabilityId, "output", record?.outputSchema);
    if (
      typeof record?.description !== "string" ||
      record.description.trim() === ""
    ) {
      notes.push({
        code: "DESCRIPTION_MISSING",
        capabilityId,
        hint: "Add a non-empty description to the capability definition.",
      });
    }
    if (record?.title === undefined) {
      notes.push({
        code: "TITLE_MISSING",
        capabilityId,
        hint: "Add a title to the capability definition.",
      });
    }
    if (record?.annotations === undefined) {
      notes.push({
        code: "ANNOTATIONS_MISSING",
        capabilityId,
        hint: "Add annotations such as { readOnly: true } to the capability definition.",
      });
    }
  }

  if (options.mcpManifestPresent !== undefined) {
    notes.push(
      options.mcpManifestPresent
        ? { code: "MCP_MANIFEST_PRESENT" }
        : {
            code: "MCP_MANIFEST_MISSING",
            hint: "Add an invokta.mcp.json manifest next to the project to make the engine installable as an MCP server (scaffolded by create-invokta-engine).",
          },
    );
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
