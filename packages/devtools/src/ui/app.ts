import { api } from "./api.js";
import {
  focusCapabilitySearch,
  renderCapabilitiesPanel,
} from "./capabilities.js";
import { renderDoctorPanel } from "./doctor-panel.js";
import { el } from "./dom.js";
import {
  ensureActiveToken,
  getActivePrincipalStatus,
  onPrincipalChange,
  renderPrincipalsPanel,
} from "./principals.js";
import { styles } from "./styles.js";
import { createThemeToggle } from "./theme.js";
import { renderTracePanel } from "./trace.js";

type TabName = "capabilities" | "trace" | "doctor" | "principals";

const tabs: ReadonlyArray<{
  readonly name: TabName;
  readonly label: string;
  readonly render: (container: HTMLElement) => () => void;
}> = [
  {
    name: "capabilities",
    label: "Playground",
    render: renderCapabilitiesPanel,
  },
  { name: "trace", label: "Activity", render: renderTracePanel },
  { name: "doctor", label: "Diagnostics", render: renderDoctorPanel },
  {
    name: "principals",
    label: "Test identities",
    render: renderPrincipalsPanel,
  },
];

/** Hash routes keep the active section shareable across reloads. */
const tabRoutes: Readonly<Record<TabName, string>> = {
  capabilities: "capabilities",
  trace: "activity",
  doctor: "diagnostics",
  principals: "identities",
};

function currentHash(): string {
  try {
    return typeof location === "undefined" ? "" : location.hash;
  } catch {
    return "";
  }
}

function tabFromHash(hash: string): TabName | undefined {
  const route = hash.replace(/^#\/?/, "").split("/")[0];
  return tabs.find((tab) => tabRoutes[tab.name] === route)?.name;
}

function syncHash(name: TabName): void {
  try {
    if (typeof location === "undefined") return;
    const current = location.hash.replace(/^#/, "");
    // A deep link such as #capabilities/<id> survives reselecting the tab.
    if (name === "capabilities" && current.startsWith("capabilities/")) return;
    const desired = `#${tabRoutes[name]}`;
    if (location.hash !== desired) location.hash = desired;
  } catch {
    // Hash routing is a convenience; the tabs work without it.
  }
}

function createBrandMark(): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const mark = document.createElementNS(namespace, "svg");
  mark.setAttribute("viewBox", "0 0 51 43");
  mark.setAttribute("width", "24");
  mark.setAttribute("height", "20");
  mark.setAttribute("fill", "none");
  mark.setAttribute("class", "brand-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("focusable", "false");

  const strokes = document.createElementNS(namespace, "g");
  strokes.setAttribute("transform", "translate(-6.5,-10.5)");
  strokes.setAttribute("stroke-width", "9");
  strokes.setAttribute("stroke-linecap", "round");
  strokes.setAttribute("stroke-linejoin", "round");

  const chevron = document.createElementNS(namespace, "path");
  chevron.setAttribute("d", "M11 15 L29 32 L11 49");
  chevron.setAttribute("stroke", "var(--accent-text)");
  const underscore = document.createElementNS(namespace, "path");
  underscore.setAttribute("d", "M36 49 H53");
  underscore.setAttribute("stroke", "var(--ink-fg)");
  strokes.append(chevron, underscore);
  mark.append(strokes);
  return mark;
}

function boot(): void {
  document.head.append(el("style", {}, [styles]));

  const main = el("main", { class: "workspace-main content-frame" }, []);
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  const panelCache = new Map<
    TabName,
    Readonly<{
      element: HTMLDivElement;
      dispose: (() => void) | undefined;
    }>
  >();
  let activePanel:
    | Readonly<{
        name: TabName;
        element: HTMLDivElement;
        dispose: (() => void) | undefined;
      }>
    | undefined;

  const show = (name: TabName): void => {
    if (activePanel?.name === name) return;

    if (activePanel !== undefined) {
      activePanel.element.remove();
      if (activePanel.name !== "capabilities") {
        activePanel.dispose?.();
      }
      activePanel = undefined;
    }

    for (const [tabName, button] of tabButtons) {
      const selected = tabName === name;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute("tabindex", selected ? "0" : "-1");
    }

    const selectedTab = tabs.find((tab) => tab.name === name);
    if (selectedTab === undefined) return;

    let panel = name === "capabilities" ? panelCache.get(name) : undefined;
    if (panel === undefined) {
      const element = el(
        "div",
        {
          id: `panel-${name}`,
          class: `workspace-panel workspace-panel--${name}`,
          role: "tabpanel",
          "aria-labelledby": `tab-${name}`,
          tabindex: "0",
        },
        [],
      );
      panel = {
        element,
        dispose: selectedTab.render(element) ?? undefined,
      };
      if (name === "capabilities") panelCache.set(name, panel);
    }

    main.append(panel.element);
    activePanel = { name, ...panel };
    syncHash(name);
  };

  const nav = el(
    "nav",
    { class: "tabs" },
    tabs.map((tab) => {
      const button = el("button", { type: "button" }, [tab.label]);
      button.id = `tab-${tab.name}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `panel-${tab.name}`);
      button.setAttribute("aria-selected", "false");
      button.setAttribute("tabindex", "-1");
      button.addEventListener("click", () => {
        show(tab.name);
      });
      tabButtons.set(tab.name, button);
      return button;
    }),
  );
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Devtools sections");
  nav.setAttribute("aria-orientation", "horizontal");
  nav.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const current = tabs.findIndex(
      ({ name }) => tabButtons.get(name) === keyboardEvent.target,
    );
    if (current < 0) return;

    let next = current;
    if (keyboardEvent.key === "ArrowRight") next = current + 1;
    else if (keyboardEvent.key === "ArrowLeft") next = current - 1;
    else if (keyboardEvent.key === "Home") next = 0;
    else if (keyboardEvent.key === "End") next = tabs.length - 1;
    else return;

    keyboardEvent.preventDefault();
    const tab = tabs.at((next + tabs.length) % tabs.length);
    if (tab === undefined) return;
    show(tab.name);
    const button = tabButtons.get(tab.name);
    button?.focus();
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  main.id = "workspace";

  const title = el("h1", {}, ["Loading engine…"]);
  title.id = "engine-title";
  const version = el("span", { class: "meta-pill engine-version" }, [
    "Version …",
  ]);
  const capabilityCount = el(
    "span",
    { class: "meta-pill engine-capability-count" },
    ["Capabilities …"],
  );
  const principalContextLabel = el("span", {}, [
    "Act as — · Checking session token…",
  ]);
  const principalContext = el(
    "button",
    {
      type: "button",
      class: "meta-pill principal-context",
      "aria-label":
        "Act as unavailable, checking session token; manage test identities",
    },
    [principalContextLabel],
  );
  principalContext.addEventListener("click", () => {
    show("principals");
    tabButtons.get("principals")?.focus();
  });
  const updatePrincipalContext = (): void => {
    const active = getActivePrincipalStatus();
    if (active === null) {
      principalContextLabel.textContent =
        "Act as — · No test identity selected";
      principalContext.setAttribute(
        "aria-label",
        "No test identity selected; manage test identities",
      );
      return;
    }
    const tokenStatus = active.hasSessionToken ? "Token ready" : "No token";
    const accessibleTokenStatus = active.hasSessionToken
      ? "session token ready"
      : "no session token";
    principalContextLabel.textContent = `Act as ${active.principalId} · ${tokenStatus}`;
    principalContext.setAttribute(
      "aria-label",
      `Act as ${active.principalId}, ${accessibleTokenStatus}; manage test identities`,
    );
  };
  onPrincipalChange(updatePrincipalContext);
  const connectionLabel = el("span", { class: "connection-label" }, [
    "Connecting…",
  ]);
  const connection = el(
    "span",
    {
      class: "connection-status pending",
      role: "status",
      "aria-live": "polite",
    },
    [
      el("span", { class: "status-dot", "aria-hidden": "true" }, []),
      connectionLabel,
    ],
  );
  const brand = el("div", { class: "brand-lockup" }, [
    createBrandMark(),
    el("span", { class: "brand-name" }, ["invokta"]),
    el("span", { class: "product-name" }, ["engine devtools"]),
  ]);
  const rails = el(
    "div",
    { class: "blueprint-rails", "aria-hidden": "true" },
    Array.from({ length: 5 }, () => el("span", {}, [])),
  );
  const topbar = el("header", { class: "app" }, [
    el("div", { class: "content-frame topbar-inner" }, [
      brand,
      nav,
      createThemeToggle(),
    ]),
  ]);
  const context = el(
    "section",
    { class: "workspace-context", "aria-labelledby": title.id },
    [
      el("div", { class: "content-frame workspace-context-inner" }, [
        el("div", { class: "workspace-title" }, [title]),
        el("div", { class: "engine-meta", "aria-label": "Engine status" }, [
          connection,
          principalContext,
          version,
          capabilityCount,
        ]),
      ]),
    ],
  );
  document.body.append(
    el("div", { class: "app-shell" }, [rails, topbar, context, main]),
  );
  show(tabFromHash(currentHash()) ?? "capabilities");

  if (typeof window !== "undefined" && typeof location !== "undefined") {
    window.addEventListener("hashchange", () => {
      const name = tabFromHash(location.hash);
      if (name !== undefined) show(name);
    });
  }

  // A tiny reference for the gestures this shell supports; "?" toggles it.
  let shortcutsOverlay: HTMLElement | undefined;
  const closeShortcuts = (): void => {
    shortcutsOverlay?.remove();
    shortcutsOverlay = undefined;
  };
  const shortcutEntry = (keys: string, action: string): HTMLElement =>
    el("div", { class: "shortcuts-entry" }, [
      el("dt", {}, [el("kbd", {}, [keys])]),
      el("dd", {}, [action]),
    ]);
  const toggleShortcuts = (): void => {
    if (shortcutsOverlay !== undefined) {
      closeShortcuts();
      return;
    }
    shortcutsOverlay = el(
      "div",
      {
        class: "shortcuts-overlay",
        role: "dialog",
        "aria-label": "Keyboard shortcuts",
      },
      [
        el("div", { class: "shortcuts-card" }, [
          el("h2", {}, ["Keyboard shortcuts"]),
          el("dl", { class: "shortcuts-list" }, [
            shortcutEntry("/", "Focus the Playground search"),
            shortcutEntry("Ctrl/⌘ + Enter", "Invoke the edited capability"),
            shortcutEntry("← →", "Move between tabs"),
            shortcutEntry("?", "Toggle this overlay"),
          ]),
          el("p", { class: "hint" }, ["Press ? or Escape to close."]),
        ]),
      ],
    );
    document.body.append(shortcutsOverlay);
  };

  // One global gesture: "/" jumps to the catalog filter from anywhere that is
  // not already a text field, matching how developers search other dev tools.
  document.body.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Escape" && shortcutsOverlay !== undefined) {
      closeShortcuts();
      keyboardEvent.preventDefault();
      return;
    }
    if (
      (keyboardEvent.key !== "/" && keyboardEvent.key !== "?") ||
      keyboardEvent.ctrlKey ||
      keyboardEvent.metaKey ||
      keyboardEvent.altKey
    ) {
      return;
    }
    const target = keyboardEvent.target as HTMLElement | null;
    const tagName = target?.tagName;
    if (
      tagName === "INPUT" ||
      tagName === "TEXTAREA" ||
      target?.isContentEditable === true
    ) {
      return;
    }
    if (keyboardEvent.key === "?") {
      keyboardEvent.preventDefault();
      toggleShortcuts();
      return;
    }
    closeShortcuts();
    show("capabilities");
    if (focusCapabilitySearch()) keyboardEvent.preventDefault();
  });

  void api
    .engine()
    .then((engine) => {
      title.textContent = engine.name;
      version.textContent = `v${engine.version}`;
      capabilityCount.textContent = `${String(engine.capabilityCount)} capabilities`;
      connectionLabel.textContent = "Connected locally";
      connection.classList.remove("pending");
    })
    .catch(() => {
      title.textContent = "Engine unavailable";
      connectionLabel.textContent = "Dev server unreachable";
      connection.classList.remove("pending");
      connection.classList.add("unavailable");
      connection.setAttribute("role", "alert");
    });

  void ensureActiveToken()
    .then(updatePrincipalContext)
    .catch(() => {
      principalContextLabel.textContent = "Act as unavailable";
      principalContext.setAttribute(
        "aria-label",
        "Test identity status unavailable; manage test identities",
      );
      // Invocations surface the 401; the rest of the interface stays usable.
    });
}

boot();
