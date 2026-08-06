import { api, type CapabilityInfo } from "./api.js";
import { clear, el, pretty } from "./dom.js";
import { renderInvokePanel } from "./invoke-panel.js";

function renderDetail(capability: CapabilityInfo): HTMLElement {
  const annotations = capability.annotations;
  return el("div", { class: "capability-detail" }, [
    el("h2", {}, [capability.title ?? capability.id]),
    el("code", { class: "capability-id" }, [capability.id]),
    el("p", {}, [capability.description]),
    annotations === undefined
      ? null
      : el(
          "p",
          { class: "annotations" },
          Object.entries(annotations)
            .filter(([, enabled]) => enabled === true)
            .map(([name]) => el("span", { class: "badge" }, [name])),
        ),
    capability.timeoutMs === undefined
      ? null
      : el("p", { class: "hint" }, [
          `Timeout: ${String(capability.timeoutMs)} ms`,
        ]),
    renderInvokePanel(capability),
    el("details", {}, [
      el("summary", {}, ["Input schema"]),
      el("pre", { class: "raw" }, [pretty(capability.inputSchema)]),
    ]),
    el("details", {}, [
      el("summary", {}, ["Output schema"]),
      el("pre", { class: "raw" }, [pretty(capability.outputSchema)]),
    ]),
  ]);
}

export function renderCapabilitiesPanel(container: HTMLElement): void {
  void api.capabilities().then((capabilities) => {
    clear(container);
    if (capabilities.length === 0) {
      container.append(el("p", {}, ["The engine publishes no capabilities."]));
      return;
    }

    const detail = el("div", { class: "capability-pane" }, []);
    const buttons: HTMLButtonElement[] = [];
    const select = (capability: CapabilityInfo, button: HTMLButtonElement) => {
      for (const other of buttons) other.classList.remove("selected");
      button.classList.add("selected");
      clear(detail);
      detail.append(renderDetail(capability));
    };

    const list = el(
      "nav",
      { class: "capability-list" },
      capabilities.map((capability) => {
        const button = el("button", { type: "button" }, [capability.id]);
        buttons.push(button);
        button.addEventListener("click", () => {
          select(capability, button);
        });
        return button;
      }),
    );

    container.append(list, detail);
    const first = capabilities[0];
    const firstButton = buttons[0];
    if (first !== undefined && firstButton !== undefined) {
      select(first, firstButton);
    }
  });
}
