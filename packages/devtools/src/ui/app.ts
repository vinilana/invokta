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
  readonly render: (container: HTMLElement) => void;
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

async function boot(): Promise<void> {
  document.head.append(el("style", {}, [styles]));

  const main = el("main", {}, []);
  const tabButtons = new Map<TabName, HTMLButtonElement>();

  const show = (name: TabName): void => {
    for (const [tabName, button] of tabButtons) {
      button.classList.toggle("selected", tabName === name);
    }
    clear(main);
    tabs.find((tab) => tab.name === name)?.render(main);
  };

  const nav = el(
    "nav",
    { class: "tabs" },
    tabs.map((tab) => {
      const button = el("button", { type: "button" }, [tab.label]);
      button.addEventListener("click", () => {
        show(tab.name);
      });
      tabButtons.set(tab.name, button);
      return button;
    }),
  );

  const title = el("h1", {}, ["Invokta devtools"]);
  const version = el("span", { class: "version" }, []);
  document.body.append(
    el("header", { class: "app" }, [title, version, nav]),
    main,
  );

  try {
    const engine = await api.engine();
    title.textContent = engine.name;
    version.textContent = `v${engine.version} — ${String(engine.capabilityCount)} capabilities`;
  } catch {
    version.textContent = "the dev server is not reachable";
  }

  try {
    await ensureActiveToken();
  } catch {
    // Invocations will surface the 401; the interface still renders.
  }

  show("capabilities");
}

void boot();
