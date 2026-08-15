import { el } from "./dom.js";

export type WorkbenchName = "mcp" | "cli";

export const workbenchLabels: Readonly<Record<WorkbenchName, string>> = {
  mcp: "MCP",
  cli: "CLI",
};

export const workbenchPaths: Readonly<Record<WorkbenchName, string>> = {
  mcp: "/mcp",
  cli: "/cli",
};

/**
 * The Invokta mark: a prompt chevron and a cursor rule, drawn from the
 * workbench palette so it follows the theme.
 */
export function createBrandMark(): SVGSVGElement {
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

function resolveDocument(ownerDocument?: Document): Document | undefined {
  if (ownerDocument !== undefined) return ownerDocument;
  return typeof document === "undefined" ? undefined : document;
}

/**
 * Where this page's JSON API is mounted. The launcher serves both workbenches
 * from one origin and says so on the document; a single-workbench server
 * leaves the default.
 */
export function workbenchApiBase(ownerDocument?: Document): string {
  const declared = resolveDocument(ownerDocument)?.body?.dataset.invoktaApi;
  return declared === undefined || declared === "" ? "/api" : declared;
}

/**
 * Which workbench this page is, when the launcher served it. It is absent on a
 * single-workbench server, where there is nothing to switch to.
 */
export function mountedWorkbench(
  ownerDocument?: Document,
): WorkbenchName | undefined {
  const declared =
    resolveDocument(ownerDocument)?.body?.dataset.invoktaWorkbench;
  return declared === "mcp" || declared === "cli" ? declared : undefined;
}

/**
 * The brand lockup. Under the launcher it returns to the chooser, so the
 * chooser stays one click away from either workbench.
 */
export function createBrandLockup(current?: WorkbenchName): HTMLElement {
  const parts = [
    createBrandMark(),
    el("span", { class: "att-brand-name" }, ["invokta"]),
    el("span", { class: "att-product-name" }, ["DevTools"]),
  ];
  if (current === undefined) return el("div", { class: "att-brand" }, parts);
  return el(
    "a",
    { class: "att-brand att-brand-link", href: "/", title: "All workbenches" },
    parts,
  );
}

/**
 * The workbench switch. Each workbench is its own page on the same origin, so
 * the control is a pair of links and the current one is marked, not disabled.
 */
export function createWorkbenchSwitch(current: WorkbenchName): HTMLElement {
  return el(
    "nav",
    { class: "att-switch", "aria-label": "Workbench" },
    (Object.keys(workbenchPaths) as WorkbenchName[]).map((name) =>
      el(
        "a",
        {
          class: "att-switch-option",
          href: workbenchPaths[name],
          ...(name === current ? { "aria-current": "page" } : {}),
        },
        [workbenchLabels[name]],
      ),
    ),
  );
}
