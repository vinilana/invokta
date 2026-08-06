import { api, type DoctorInfo } from "./api.js";
import { clear, el, pretty } from "./dom.js";

type DiagnosticKind = "finding" | "note";
type Diagnostic = Readonly<Record<string, unknown>>;

function readString(
  diagnostic: Diagnostic,
  property: string,
): string | undefined {
  const value = diagnostic[property];
  return typeof value === "string" ? value : undefined;
}

function readErrorMessage(diagnostic: Diagnostic): string | undefined {
  const error = diagnostic.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return undefined;
  }
  return readString(error as Diagnostic, "message");
}

function describeDiagnostic(
  kind: DiagnosticKind,
  diagnostic: Diagnostic,
): string {
  const capabilityId = readString(diagnostic, "capabilityId");
  const errorMessage = readErrorMessage(diagnostic);
  switch (readString(diagnostic, "code")) {
    case "LIST_UNREADABLE":
      return errorMessage ?? "The engine capability list could not be read.";
    case "DESCRIBE_FAILED":
      return `${capabilityId ?? "Unknown capability"} — ${
        errorMessage ?? "The capability description could not be read."
      }`;
    case "SCHEMA_UNREADABLE": {
      const schema = readString(diagnostic, "schema") ?? "Capability";
      return `${capabilityId ?? "Unknown capability"} — ${schema} schema is missing or unreadable.`;
    }
    case "TITLE_MISSING":
      return `${capabilityId ?? "Unknown capability"} — no display title is declared.`;
    case "ANNOTATIONS_MISSING":
      return `${capabilityId ?? "Unknown capability"} — no annotations are declared.`;
    case "MCP_MANIFEST_PRESENT":
      return "invokta.mcp.json is present in the working directory.";
    case "MCP_MANIFEST_MISSING":
      return "No invokta.mcp.json was found in the working directory.";
    case "COMPOSITION_CHECK_AVAILABLE":
      return "Run invokta check-capabilities to inspect composition provenance.";
    default:
      return kind === "finding"
        ? "The doctor reported an issue that needs attention."
        : "Additional doctor information is available.";
  }
}

function renderDiagnostic(
  kind: DiagnosticKind,
  diagnostic: Diagnostic,
): HTMLLIElement {
  const code = readString(diagnostic, "code") ?? "UNKNOWN_DIAGNOSTIC";
  const isFinding = kind === "finding";
  return el(
    "li",
    {
      class: `diagnostic-item diagnostic-item--${kind}`,
    },
    [
      el("div", { class: "diagnostic-heading" }, [
        el("span", { class: `badge ${isFinding ? "error" : "warn"}` }, [
          isFinding ? "Finding" : "Note",
        ]),
        el("code", { class: "diagnostic-code" }, [code]),
      ]),
      el("p", { class: "diagnostic-message" }, [
        describeDiagnostic(kind, diagnostic),
      ]),
      el("details", { class: "diagnostic-details" }, [
        el("summary", {}, ["Raw details"]),
        el("pre", { class: `raw${isFinding ? " error" : ""}` }, [
          pretty(diagnostic),
        ]),
      ]),
    ],
  );
}

function renderDiagnosticSection(
  kind: DiagnosticKind,
  diagnostics: DoctorInfo["findings"] | DoctorInfo["notes"],
): HTMLElement {
  const isFinding = kind === "finding";
  const title = isFinding ? "Findings" : "Advisory notes";
  const id = `doctor-${isFinding ? "findings" : "notes"}-title`;
  const count = diagnostics.length;
  return el("section", { class: "diagnostic-section", "aria-labelledby": id }, [
    el("div", { class: "diagnostic-section-heading" }, [
      el("h3", { id }, [title]),
      el("span", { class: "badge" }, [String(count)]),
    ]),
    count === 0
      ? el("p", { class: "empty doctor-empty" }, [
          isFinding ? "No blocking findings." : "No advisory notes.",
        ])
      : el(
          "ol",
          {
            class: "diagnostic-list",
            "aria-label": `Doctor ${isFinding ? "findings" : "notes"}`,
          },
          diagnostics.map((diagnostic) => renderDiagnostic(kind, diagnostic)),
        ),
  ]);
}

function renderReport(report: DoctorInfo): HTMLElement {
  const findingCount = report.findings.length;
  const healthy = findingCount === 0;
  const capabilityCount =
    report.capabilityCount === undefined
      ? "Unreadable"
      : String(report.capabilityCount);
  const statusText = healthy
    ? "Checks passed"
    : findingCount === 1
      ? "1 finding needs attention"
      : `${String(findingCount)} findings need attention`;

  return el(
    "section",
    { class: "doctor-panel", "aria-labelledby": "doctor-title" },
    [
      el("p", { class: "eyebrow" }, ["[ engine / diagnostics ]"]),
      el("div", { class: "doctor-heading" }, [
        el("div", { class: "doctor-title-group" }, [
          el("h2", { id: "doctor-title" }, ["Doctor"]),
          el("p", { class: "hint doctor-engine" }, [
            `${report.engineName} ${report.engineVersion}`,
          ]),
        ]),
        el(
          "p",
          {
            class: `doctor-state badge ${healthy ? "ok" : "error"}`,
            role: "status",
            "aria-live": "polite",
            "aria-atomic": "true",
          },
          [statusText],
        ),
      ]),
      el(
        "div",
        {
          class: `doctor-summary doctor-summary--${
            healthy ? "healthy" : "issues"
          }`,
        },
        [
          el("p", { class: "doctor-summary-copy" }, [
            healthy
              ? "The engine passed every blocking doctor check."
              : "Review the blocking findings before serving the engine.",
          ]),
          el("dl", { class: "doctor-stats", "aria-label": "Doctor summary" }, [
            el("div", { class: "doctor-stat" }, [
              el("dt", {}, ["Capabilities"]),
              el("dd", {}, [capabilityCount]),
            ]),
            el("div", { class: "doctor-stat" }, [
              el("dt", {}, ["Findings"]),
              el("dd", {}, [String(findingCount)]),
            ]),
            el("div", { class: "doctor-stat" }, [
              el("dt", {}, ["Notes"]),
              el("dd", {}, [String(report.notes.length)]),
            ]),
          ]),
        ],
      ),
      renderDiagnosticSection("finding", report.findings),
      renderDiagnosticSection("note", report.notes),
    ],
  );
}

export function renderDoctorPanel(container: HTMLElement): () => void {
  let active = true;
  clear(container);
  container.append(
    el("h2", {}, ["Doctor"]),
    el(
      "p",
      {
        class: "hint",
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
      },
      ["Running checks…"],
    ),
  );

  void api
    .doctor()
    .then((report) => {
      if (!active) return;
      clear(container);
      container.append(renderReport(report));
    })
    .catch(() => {
      if (!active) return;
      clear(container);
      container.append(
        el("h2", {}, ["Doctor"]),
        el(
          "p",
          {
            class: "feedback doctor-load-error",
            role: "alert",
            "aria-atomic": "true",
          },
          [
            "Doctor checks could not be loaded. Check that the dev server is still running.",
          ],
        ),
      );
    });

  return () => {
    active = false;
  };
}
