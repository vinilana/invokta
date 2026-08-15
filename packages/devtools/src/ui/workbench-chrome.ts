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

/** The chooser: where a workbench is selected. */
export const chooserPath = "/";
export const chooserLabel = "All workbenches";

export interface WorkbenchChoice {
  readonly workbench: WorkbenchName;
  readonly title: string;
  /** One line, for a card that sits next to another one. */
  readonly short: string;
  readonly summary: string;
  readonly connects: string;
  readonly flag: string;
}

export const workbenchChoices: readonly WorkbenchChoice[] = [
  {
    workbench: "mcp",
    title: "MCP workbench",
    short: "Inspect an installed MCP server",
    summary:
      "Inspect an installed MCP server: list its tools, call one, and read the exchange.",
    connects: "Connects a stdio command or a Streamable HTTP URL.",
    flag: "invokta-devtools open --mcp",
  },
  {
    workbench: "cli",
    title: "CLI workbench",
    short: "Inspect an installed Invokta CLI",
    summary:
      "Inspect an installed Invokta CLI: list its capabilities, describe one, and run it.",
    connects:
      "Connects an executable with its arguments, cwd, and environment.",
    flag: "invokta-devtools open --cli",
  },
];

export function workbenchChoice(workbench: WorkbenchName): WorkbenchChoice {
  return workbenchChoices.find(
    (choice) => choice.workbench === workbench,
  ) as WorkbenchChoice;
}

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
 * the control is a set of links and the current one is marked, not disabled.
 * It leads with the way back to the chooser, because selecting a workbench
 * again has to stay reachable from inside one.
 */
export function createWorkbenchSwitch(current: WorkbenchName): HTMLElement {
  return el("nav", { class: "att-switch", "aria-label": "Workbench" }, [
    el(
      "a",
      {
        class: "att-switch-home",
        href: chooserPath,
        title: chooserLabel,
        "aria-label": chooserLabel,
      },
      [
        el("span", { class: "att-switch-home-mark", "aria-hidden": "true" }, [
          "‹",
        ]),
        el("span", { class: "att-switch-home-label" }, [chooserLabel]),
      ],
    ),
    ...(Object.keys(workbenchPaths) as WorkbenchName[]).map((name) =>
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
  ]);
}

function createOrientationLink(
  href: string,
  title: string,
  hint: string,
): HTMLElement {
  return el("a", { class: "att-orient-link", href }, [
    el("span", { class: "att-orient-link-title" }, [title]),
    el("span", { class: "att-orient-link-hint" }, [hint]),
  ]);
}

/**
 * The way out of an idle workbench: back to the chooser, or straight into the
 * other workbench. Both are same-origin pages, so this is navigation rather
 * than a command to retype in a terminal. Absent on a single-workbench server,
 * where neither destination exists.
 */
export function createWorkbenchOrientation(
  current: WorkbenchName | undefined,
): HTMLElement | undefined {
  if (current === undefined) return undefined;
  const peer = workbenchChoice(current === "mcp" ? "cli" : "mcp");
  return el("div", { class: "att-orient-links" }, [
    createOrientationLink(
      chooserPath,
      chooserLabel,
      "Choose which workbench to open",
    ),
    createOrientationLink(
      workbenchPaths[peer.workbench],
      peer.title,
      peer.short,
    ),
  ]);
}
