import { api } from "./api.js";
import { renderCapabilitiesPanel } from "./capabilities.js";
import { renderDoctorPanel } from "./doctor-panel.js";
import { clear, el } from "./dom.js";
import { ensureActiveToken, renderPrincipalsPanel } from "./principals.js";
import { styles } from "./styles.js";
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

  const main = el("main", {}, []);
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  let disposePanel: (() => void) | undefined;

  const show = (name: TabName): void => {
    disposePanel?.();
    disposePanel = undefined;
    for (const [tabName, button] of tabButtons) {
      const selected = tabName === name;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
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
      button.addEventListener("click", () => {
        show(tab.name);
      });
      tabButtons.set(tab.name, button);
      return button;
    }),
  );
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Devtools sections");
  main.id = "active-panel";
  main.setAttribute("role", "tabpanel");

  const title = el("h1", {}, ["Invokta devtools"]);
  const version = el("span", { class: "version" }, []);
  document.body.append(
    el("header", { class: "app" }, [title, version, nav]),
    main,
  );
  show("capabilities");

  void api
    .engine()
    .then((engine) => {
      title.textContent = engine.name;
      version.textContent = `v${engine.version} — ${String(engine.capabilityCount)} capabilities`;
    })
    .catch(() => {
      version.textContent = "Dev server unreachable";
      version.setAttribute("role", "alert");
    });

  void ensureActiveToken().catch(() => {
    // Invocations surface the 401; the rest of the interface stays usable.
  });
}

boot();
