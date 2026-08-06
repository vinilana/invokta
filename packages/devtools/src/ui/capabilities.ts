import { api, type CapabilityInfo } from "./api.js";
import { clear, el, pretty } from "./dom.js";
import { renderInvokePanel } from "./invoke-panel.js";

function capabilityChoiceLabel(capability: CapabilityInfo): string {
  const title = capability.title?.trim();
  if (title === undefined || title === "" || title === capability.id) {
    return capability.id;
  }
  return `${title} · ${capability.id}`;
}

function renderDetail(capability: CapabilityInfo): HTMLElement {
  const annotations = Object.entries(capability.annotations ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);
  return el("div", { class: "capability-detail" }, [
    el("p", { class: "eyebrow" }, ["[ capability / detail ]"]),
    el("div", { class: "capability-heading" }, [
      el("h2", {}, [capability.title ?? capability.id]),
      el("code", { class: "capability-id" }, [capability.id]),
    ]),
    el("p", { class: "capability-description" }, [capability.description]),
    annotations.length === 0
      ? null
      : el(
          "p",
          { class: "annotations", "aria-label": "Capability annotations" },
          [
            "Annotations: ",
            ...annotations.map((name) =>
              el("span", { class: "badge" }, [name]),
            ),
          ],
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
    el("p", { class: "hint", role: "status" }, ["Loading capability catalog…"]),
  );

  void api
    .capabilities()
    .then((capabilities) => {
      if (!active) return;
      clear(container);
      if (capabilities.length === 0) {
        container.append(
          el("h2", {}, ["Capabilities"]),
          el("p", { class: "empty", role: "status" }, [
            "No capabilities published. Add a capability to this engine to inspect its contract and invoke it here.",
          ]),
        );
        return;
      }

      const detailId = "capability-detail";
      const detail = el(
        "section",
        {
          id: detailId,
          class: "capability-pane",
          role: "region",
        },
        [],
      );
      const buttons: HTMLButtonElement[] = [];
      const select = (
        capability: CapabilityInfo,
        button: HTMLButtonElement,
      ) => {
        for (const other of buttons) {
          const selected = other === button;
          other.classList.toggle("selected", selected);
          other.setAttribute("aria-pressed", selected ? "true" : "false");
        }
        detail.setAttribute("aria-labelledby", button.getAttribute("id") ?? "");
        clear(detail);
        detail.append(renderDetail(capability));
      };

      const list = el(
        "nav",
        { class: "capability-list", "aria-label": "Engine capabilities" },
        capabilities.map((capability, index) => {
          const label = capabilityChoiceLabel(capability);
          const button = el(
            "button",
            {
              id: `capability-choice-${String(index + 1)}`,
              type: "button",
              "aria-controls": detailId,
              "aria-pressed": "false",
              title: `${label}\n${capability.description}`,
            },
            [label],
          );
          buttons.push(button);
          button.addEventListener("click", () => {
            select(capability, button);
          });
          return button;
        }),
      );

      const sidebar = el("aside", { class: "capability-sidebar" }, [
        el("p", { class: "eyebrow" }, ["[ engine / capabilities ]"]),
        el("p", { class: "hint" }, [
          `${String(capabilities.length)} published ${capabilities.length === 1 ? "capability" : "capabilities"}. Select one to inspect its contract and invoke it locally.`,
        ]),
        list,
      ]);
      container.append(
        el("div", { class: "capabilities-layout" }, [sidebar, detail]),
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
          "Capabilities could not be loaded. Confirm the dev server is running, then reload this view.",
        ]),
      );
    });

  return () => {
    active = false;
  };
}
