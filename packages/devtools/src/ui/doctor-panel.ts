import { api, type DoctorInfo } from "./api.js";
import { createCopyButton } from "./clipboard.js";
import { clear, el, pretty } from "./dom.js";

const compositionCheckCommand = "invokta check-capabilities";
const restartRecheckDelayMs = 250;

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
      return `Run ${compositionCheckCommand} to inspect composition provenance.`;
    default:
      return kind === "finding"
        ? "The doctor reported an issue that needs attention."
        : "Additional doctor information is available.";
  }
}

/** Routes to the Playground and asks the invoke panel to select a capability. */
function openInPlayground(capabilityId: string): void {
  try {
    if (typeof location !== "undefined") {
      location.hash = `#capabilities/${encodeURIComponent(capabilityId)}`;
    }
  } catch {
    // Hash routing is a convenience; the selection event still fires.
  }
  try {
    if (
      typeof CustomEvent === "function" &&
      typeof document.dispatchEvent === "function"
    ) {
      document.dispatchEvent(
        new CustomEvent("invokta:select-capability", {
          detail: { id: capabilityId },
        }),
      );
    }
  } catch {
    // The invoke panel may not be listening.
  }
}

function renderDiagnostic(
  kind: DiagnosticKind,
  diagnostic: Diagnostic,
  index: number,
): HTMLLIElement {
  const code = readString(diagnostic, "code") ?? "UNKNOWN_DIAGNOSTIC";
  const isFinding = kind === "finding";
  const hint = readString(diagnostic, "hint");
  const capabilityId = readString(diagnostic, "capabilityId");
  const codeId = `doctor-${kind}-${String(index)}-code`;
  const messageId = `doctor-${kind}-${String(index)}-message`;
  const actions: HTMLElement[] = [];
  if (code === "COMPOSITION_CHECK_AVAILABLE") {
    actions.push(
      createCopyButton("command", () => compositionCheckCommand, "copy-button"),
    );
  }
  if (capabilityId !== undefined) {
    const playground = el(
      "button",
      {
        type: "button",
        class: "diagnostic-playground",
        title: `Inspect ${capabilityId} in the Playground`,
      },
      ["Open in Playground"],
    );
    playground.addEventListener("click", () => {
      openInPlayground(capabilityId);
    });
    actions.push(playground);
  }
  return el(
    "li",
    {
      class: `diagnostic-item diagnostic-item--${kind}`,
      "aria-labelledby": codeId,
      "aria-describedby": messageId,
    },
    [
      el("div", { class: "diagnostic-item-body" }, [
        el("div", { class: "diagnostic-heading" }, [
          el("span", { class: `badge ${isFinding ? "error" : "warn"}` }, [
            isFinding ? "Finding" : "Note",
          ]),
          el("code", { class: "diagnostic-code", id: codeId }, [code]),
        ]),
        el("p", { class: "diagnostic-message", id: messageId }, [
          describeDiagnostic(kind, diagnostic),
        ]),
        hint === undefined
          ? null
          : el("p", { class: "diagnostic-hint" }, [hint]),
        actions.length === 0
          ? null
          : el("div", { class: "diagnostic-actions" }, actions),
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
  const title = isFinding ? "Findings" : "Notes";
  const id = `doctor-${isFinding ? "findings" : "notes"}-title`;
  const count = diagnostics.length;
  return el(
    "section",
    {
      class: `diagnostic-section diagnostic-section--${kind}${
        count === 0 ? " diagnostic-section--empty" : ""
      }`,
      "aria-labelledby": id,
    },
    [
      el("div", { class: "diagnostic-section-heading" }, [
        el("div", { class: "diagnostic-section-title-group" }, [
          el("h3", { id }, [title]),
          el("span", { class: "badge diagnostic-count" }, [String(count)]),
        ]),
      ]),
      count === 0
        ? el("p", { class: "empty doctor-empty" }, [
            isFinding ? "No blocking findings." : "No notes.",
          ])
        : el(
            "ol",
            {
              class: "diagnostic-list",
              "aria-label": `Doctor ${isFinding ? "findings" : "notes"}`,
            },
            diagnostics.map((diagnostic, index) =>
              renderDiagnostic(kind, diagnostic, index),
            ),
          ),
    ],
  );
}

function renderReport(report: DoctorInfo): HTMLElement {
  const findingCount = report.findings.length;
  const healthy = findingCount === 0;
  const capabilityCount =
    report.capabilityCount === undefined
      ? "Unreadable"
      : String(report.capabilityCount);
  return el("div", { class: "doctor-report" }, [
    el(
      "div",
      {
        class: `doctor-summary doctor-summary--${
          healthy ? "healthy" : "issues"
        }`,
      },
      [
        el("div", { class: "doctor-summary-signal" }, [
          el("p", { class: "doctor-summary-copy" }, [
            healthy
              ? "No blocking issues found."
              : "Resolve findings before serving the engine.",
          ]),
        ]),
        el("dl", { class: "doctor-stats", "aria-label": "Doctor summary" }, [
          el("div", { class: "doctor-stat doctor-stat--capabilities" }, [
            el("dt", {}, ["Capabilities"]),
            el("dd", {}, [capabilityCount]),
          ]),
          el("div", { class: "doctor-stat doctor-stat--findings" }, [
            el("dt", {}, ["Findings"]),
            el("dd", {}, [String(findingCount)]),
          ]),
          el("div", { class: "doctor-stat doctor-stat--notes" }, [
            el("dt", {}, ["Notes"]),
            el("dd", {}, [String(report.notes.length)]),
          ]),
        ]),
      ],
    ),
    el("div", { class: "doctor-sections" }, [
      renderDiagnosticSection("finding", report.findings),
      renderDiagnosticSection("note", report.notes),
    ]),
  ]);
}

export function renderDoctorPanel(container: HTMLElement): () => void {
  let active = true;
  let loading = false;
  clear(container);
  const engine = el("p", { class: "hint doctor-engine" }, []);
  const status = el(
    "p",
    {
      class: "doctor-state hint",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    ["Running checks…"],
  );
  const refresh = el(
    "button",
    {
      class: "secondary doctor-refresh",
      type: "button",
      "aria-label": "Run doctor checks again",
      "aria-controls": "doctor-report",
    },
    ["Run again"],
  );
  refresh.disabled = true;
  const reportContent = el(
    "div",
    { class: "doctor-content", id: "doctor-report" },
    [],
  );
  const panel = el(
    "section",
    {
      class: "doctor-panel",
      "aria-labelledby": "doctor-title",
      "aria-busy": "true",
    },
    [
      el("div", { class: "doctor-heading" }, [
        el("div", { class: "doctor-title-group" }, [
          el("h2", { id: "doctor-title" }, ["Doctor"]),
          engine,
        ]),
        el("div", { class: "doctor-actions" }, [status, refresh]),
      ]),
      reportContent,
    ],
  );
  container.append(panel);

  const runChecks = async (reason?: "restart"): Promise<void> => {
    if (!active || loading) return;
    loading = true;
    panel.setAttribute("aria-busy", "true");
    refresh.disabled = true;
    status.setAttribute("class", "doctor-state hint");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent =
      reason === "restart" ? "Re-checking after restart…" : "Running checks…";

    try {
      const report = await api.doctor();
      if (!active) return;
      clear(reportContent);
      reportContent.append(renderReport(report));
      engine.textContent = `${report.engineName} ${report.engineVersion}`;
      const healthy = report.findings.length === 0;
      status.setAttribute(
        "class",
        `doctor-state badge ${healthy ? "ok" : "error"}`,
      );
      status.textContent = healthy ? "Healthy" : "Issues found";
    } catch {
      if (!active) return;
      clear(reportContent);
      engine.textContent = "";
      status.setAttribute("class", "feedback doctor-load-error");
      status.setAttribute("role", "alert");
      status.setAttribute("aria-live", "assertive");
      status.textContent =
        "Doctor checks could not be loaded. Check that the dev server is still running.";
    } finally {
      loading = false;
      if (active) {
        panel.setAttribute("aria-busy", "false");
        refresh.disabled = false;
      }
    }
  };

  const handleRefresh = (): void => {
    void runChecks();
  };
  refresh.addEventListener("click", handleRefresh);

  // A restart invalidates every check result, so the same lifecycle stream the
  // trace panel consumes triggers a debounced re-run here.
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let source: EventSource | undefined;
  if (typeof EventSource === "function") {
    source = new EventSource("/api/events");
    source.addEventListener("trace", (event) => {
      try {
        const entry = JSON.parse((event as MessageEvent<string>).data) as {
          readonly kind?: string;
          readonly notice?: string;
        };
        if (entry.kind !== "notice" || entry.notice !== "engine-restarted") {
          return;
        }
        if (restartTimer !== undefined) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          restartTimer = undefined;
          void runChecks("restart");
        }, restartRecheckDelayMs);
      } catch {
        // A malformed frame is dropped; the stream continues.
      }
    });
  }

  void runChecks();

  return () => {
    active = false;
    refresh.removeEventListener("click", handleRefresh);
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    restartTimer = undefined;
    source?.close();
  };
}
