import { api } from "./api.js";
import { renderCapabilitiesPanel } from "./capabilities.js";
import { renderDoctorPanel } from "./doctor-panel.js";
import { clear, el } from "./dom.js";
import { ensureActiveToken, renderPrincipalsPanel } from "./principals.js";
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
    label: "Capabilities",
    render: renderCapabilitiesPanel,
  },
  { name: "trace", label: "Trace", render: renderTracePanel },
  { name: "doctor", label: "Doctor", render: renderDoctorPanel },
  { name: "principals", label: "Principals", render: renderPrincipalsPanel },
];

function boot(): void {
  document.head.append(el("style", {}, [styles]));

  const main = el("main", { class: "workspace-main content-frame" }, []);
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  let disposePanel: (() => void) | undefined;

  const show = (name: TabName): void => {
    disposePanel?.();
    disposePanel = undefined;
    for (const [tabName, button] of tabButtons) {
      const selected = tabName === name;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute("tabindex", selected ? "0" : "-1");
    }
    clear(main);
    const selectedTab = tabs.find((tab) => tab.name === name);
    if (selectedTab === undefined) return;
    main.setAttribute("aria-labelledby", `tab-${name}`);
    disposePanel = selectedTab.render(main) ?? undefined;
  };

  const nav = el(
    "nav",
    { class: "tabs" },
    tabs.map((tab) => {
      const button = el("button", { type: "button" }, [tab.label]);
      button.id = `tab-${tab.name}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "active-panel");
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
  main.id = "active-panel";
  main.setAttribute("role", "tabpanel");
  main.setAttribute("tabindex", "0");

  const title = el("h1", {}, ["Connecting to engine…"]);
  title.id = "engine-title";
  const version = el("span", { class: "meta-pill" }, ["Version —"]);
  const capabilityCount = el("span", { class: "meta-pill" }, [
    "Capabilities —",
  ]);
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
    el("span", { class: "brand-mark", "aria-hidden": "true" }, [
      el("span", { class: "brand-chevron" }, [">"]),
      el("span", { class: "brand-underscore" }, ["_"]),
    ]),
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
        el("div", { class: "workspace-title" }, [
          el("p", { class: "eyebrow" }, ["[ local / engine ]"]),
          title,
        ]),
        el("div", { class: "engine-meta", "aria-label": "Engine status" }, [
          connection,
          version,
          capabilityCount,
        ]),
      ]),
    ],
  );
  document.body.append(
    el("div", { class: "app-shell" }, [rails, topbar, context, main]),
  );
  show("capabilities");

  void api
    .engine()
    .then((engine) => {
      title.textContent = engine.name;
      version.textContent = `v${engine.version}`;
      capabilityCount.textContent = `${String(engine.capabilityCount)} capabilities`;
      connectionLabel.textContent = "Local server";
      connection.classList.remove("pending");
    })
    .catch(() => {
      title.textContent = "Engine unavailable";
      connectionLabel.textContent = "Dev server unreachable";
      connection.classList.remove("pending");
      connection.classList.add("unavailable");
      connection.setAttribute("role", "alert");
    });

  void ensureActiveToken().catch(() => {
    // Invocations surface the 401; the rest of the interface stays usable.
  });
}

boot();
