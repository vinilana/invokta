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

export function renderCapabilitiesPanel(container: HTMLElement): () => void {
  let active = true;
  clear(container);
  container.append(
    el("h2", {}, ["Capabilities"]),
    el("p", { class: "hint", role: "status" }, ["Loading capabilities…"]),
  );

  void api
    .capabilities()
    .then((capabilities) => {
      if (!active) return;
      clear(container);
      if (capabilities.length === 0) {
        container.append(
          el("h2", {}, ["Capabilities"]),
          el("p", { class: "empty" }, [
            "The engine publishes no capabilities.",
          ]),
        );
        return;
      }

      const detail = el("div", { class: "capability-pane" }, []);
      const buttons: HTMLButtonElement[] = [];
      const select = (
        capability: CapabilityInfo,
        button: HTMLButtonElement,
      ) => {
        for (const other of buttons) {
          const selected = other === button;
          other.classList.toggle("selected", selected);
          other.setAttribute("aria-current", selected ? "true" : "false");
        }
        clear(detail);
        detail.append(renderDetail(capability));
      };

      const list = el(
        "nav",
        { class: "capability-list", "aria-label": "Engine capabilities" },
        capabilities.map((capability) => {
          const button = el("button", { type: "button" }, [capability.id]);
          buttons.push(button);
          button.addEventListener("click", () => {
            select(capability, button);
          });
          return button;
        }),
      );

      container.append(
        el("div", { class: "capabilities-layout" }, [list, detail]),
      );
      const first = capabilities[0];
      const firstButton = buttons[0];
      if (first !== undefined && firstButton !== undefined) {
        select(first, firstButton);
      }
    })
    .catch(() => {
      if (!active) return;
      clear(container);
      container.append(
        el("h2", {}, ["Capabilities"]),
        el("p", { class: "feedback", role: "alert" }, [
          "Capabilities could not be loaded. Check that the dev server is still running.",
        ]),
      );
    });

  return () => {
    active = false;
  };
}
