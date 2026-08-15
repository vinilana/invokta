import type {
  CliActivityRecord,
  CliConnectionState,
  CliJsonValue,
} from "./cli-contract.js";
import { el } from "./dom.js";

export function createCliBrandMark(): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const mark = document.createElementNS(namespace, "svg");
  mark.setAttribute("viewBox", "0 0 51 43");
  mark.setAttribute("width", "24");
  mark.setAttribute("height", "20");
  mark.setAttribute("fill", "none");
  mark.setAttribute("class", "att-brand-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("focusable", "false");
  const strokes = document.createElementNS(namespace, "g");
  strokes.setAttribute("transform", "translate(-6.5,-10.5)");
  strokes.setAttribute("stroke-width", "9");
  strokes.setAttribute("stroke-linecap", "round");
  strokes.setAttribute("stroke-linejoin", "round");
  const prompt = document.createElementNS(namespace, "path");
  prompt.setAttribute("d", "M11 15 L29 32 L11 49");
  prompt.setAttribute("stroke", "var(--att-accent-text)");
  const cursor = document.createElementNS(namespace, "path");
  cursor.setAttribute("d", "M36 49 H53");
  cursor.setAttribute("stroke", "var(--att-fg)");
  strokes.append(prompt, cursor);
  mark.append(strokes);
  return mark;
}

let controlSequence = 0;

export function cliControlId(name: string): string {
  controlSequence += 1;
  return `cli-${name}-${String(controlSequence)}`;
}

export function cliLabelFor(
  text: string,
  id: string,
  className = "att-label",
): HTMLLabelElement {
  return el("label", { for: id, class: className }, [text]);
}

export function cliTextInput(options: {
  readonly label: string;
  readonly name: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly type?: "text" | "search" | "password";
  readonly autocomplete?: string;
}): { readonly field: HTMLDivElement; readonly input: HTMLInputElement } {
  const id = cliControlId(options.name);
  const input = el("input", {
    id,
    class: "att-input",
    type: options.type ?? "text",
    ...(options.placeholder === undefined
      ? {}
      : { placeholder: options.placeholder }),
    ...(options.autocomplete === undefined
      ? {}
      : { autocomplete: options.autocomplete }),
  });
  input.value = options.value ?? "";
  return {
    field: el("div", {}, [cliLabelFor(options.label, id), input]),
    input,
  };
}

export function cliErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local request could not be completed.";
}

const annotationLabels: Readonly<Record<string, string>> = {
  readOnly: "Read-only",
  destructive: "Destructive",
  idempotent: "Idempotent",
  openWorld: "Open world",
};

export function cliAnnotationTags(
  annotations: Readonly<Record<string, CliJsonValue>> | undefined,
): readonly HTMLElement[] {
  return Object.entries(annotations ?? {})
    .filter(([, value]) => value === true)
    .map(([name]) =>
      el(
        "span",
        {
          class: `att-tag${name === "destructive" ? " danger" : ""}`,
        },
        [annotationLabels[name] ?? name],
      ),
    );
}

function clockReading(instant: string): string {
  const separator = instant.indexOf("T");
  if (separator === -1) return instant;
  return instant.slice(separator + 1).replace("Z", "");
}

export function cliActivityTable(
  records: readonly CliActivityRecord[],
): HTMLElement {
  const body = el(
    "tbody",
    {},
    records.map((record) =>
      el("tr", {}, [
        el("td", { class: "att-mono" }, [String(record.sequence)]),
        el("td", {}, [record.operation]),
        el("td", { class: "att-mono" }, [record.capabilityId ?? "—"]),
        el("td", { class: "att-mono att-numeric" }, [
          record.exitCode === undefined || record.exitCode === null
            ? "—"
            : String(record.exitCode),
        ]),
        el(
          "td",
          {
            class: "att-mono att-numeric",
            title: clockReading(record.startedAt),
          },
          [`${String(record.durationMs)} ms`],
        ),
        el(
          "td",
          {
            class: `att-status-text ${record.outcome === "success" ? "success" : "error"}`,
          },
          [record.errorCode ?? record.outcome],
        ),
      ]),
    ),
  );
  return el("table", { class: "att-activity-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Sequence"]),
        el("th", { scope: "col" }, ["Verb"]),
        el("th", { scope: "col" }, ["Id"]),
        el("th", { scope: "col" }, ["Exit"]),
        el("th", { scope: "col" }, ["Duration"]),
        el("th", { scope: "col" }, ["Outcome"]),
      ]),
    ]),
    body,
  ]);
}

export function cliStatusPill(state: CliConnectionState): HTMLElement {
  const label =
    state.state === "connected"
      ? "Connected"
      : state.state === "idle"
        ? "Not connected"
        : state.state === "busy"
          ? "Target busy"
          : state.state === "connecting"
            ? "Connecting"
            : "Closing";
  const tone =
    state.state === "connected"
      ? "success"
      : state.state === "idle"
        ? ""
        : "warning";
  return el(
    "span",
    {
      class: `att-pill ${tone}`.trim(),
      role: "status",
      "aria-live": "polite",
    },
    [el("span", { class: "att-dot", "aria-hidden": "true" }, []), label],
  );
}
