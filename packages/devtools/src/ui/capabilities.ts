import { api, type CapabilityInfo } from "./api.js";
import { clear, el, type Child } from "./dom.js";
import { renderInvokePanel } from "./invoke-panel.js";
import { renderSchemaView } from "./schema-view.js";

function capabilityTitle(capability: CapabilityInfo): string {
  const title = capability.title?.trim();
  return title === undefined || title === "" ? "Untitled capability" : title;
}

function renderDetail(capability: CapabilityInfo): HTMLElement {
  const annotations = Object.entries(capability.annotations ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);
  const metadata: Child[] = annotations.map((name) =>
    el("span", { class: "badge" }, [name]),
  );
  if (capability.timeoutMs !== undefined) {
    metadata.push(
      el("span", { class: "badge" }, [
        `${new Intl.NumberFormat("en-US").format(capability.timeoutMs)} ms timeout`,
      ]),
    );
  }
  return el("div", { class: "capability-detail" }, [
    el("header", { class: "capability-overview" }, [
      el("div", { class: "capability-heading" }, [
        el("h2", {}, [capabilityTitle(capability)]),
        el("code", { class: "capability-id" }, [capability.id]),
      ]),
      el("p", { class: "capability-description" }, [capability.description]),
      metadata.length === 0
        ? null
        : el(
            "div",
            { class: "capability-meta", "aria-label": "Capability metadata" },
            metadata,
          ),
    ]),
    renderInvokePanel(capability),
    el("div", { class: "schema-grid" }, [
      renderSchemaView("Input", capability.inputSchema),
      renderSchemaView("Output", capability.outputSchema),
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
            "No capabilities published. Add one to inspect its contract and test it here.",
          ]),
        );
        return;
      }

      const detailId = "capability-detail";
      const sidebarHeadingId = "capability-sidebar-heading";
      const listId = "capability-list";
      const searchId = "capability-search";
      const detail = el(
        "section",
        {
          id: detailId,
          class: "capability-pane",
          role: "tabpanel",
          tabindex: "0",
        },
        [],
      );
      const choices: Array<{
        readonly capability: CapabilityInfo;
        readonly button: HTMLButtonElement;
        readonly searchText: string;
      }> = [];
      const detailViews = new Map<CapabilityInfo, HTMLElement>();
      let selectedButton: HTMLButtonElement | undefined;

      const select = (
        capability: CapabilityInfo,
        button: HTMLButtonElement,
      ) => {
        selectedButton = button;
        for (const { button: other } of choices) {
          const selected = other === button;
          other.classList.toggle("selected", selected);
          other.setAttribute("aria-selected", selected ? "true" : "false");
          other.setAttribute("tabindex", selected ? "0" : "-1");
        }
        detail.setAttribute("aria-labelledby", button.getAttribute("id") ?? "");
        let detailView = detailViews.get(capability);
        if (detailView === undefined) {
          detailView = renderDetail(capability);
          detailViews.set(capability, detailView);
        }
        clear(detail);
        detail.append(detailView);
        detail.scrollTop = 0;
      };

      for (const [index, capability] of capabilities.entries()) {
        const title = capabilityTitle(capability);
        const button = el(
          "button",
          {
            id: `capability-choice-${String(index + 1)}`,
            class: "capability-choice",
            type: "button",
            role: "tab",
            "aria-controls": detailId,
            "aria-selected": "false",
            "aria-label": `${title}, ${capability.id}`,
            tabindex: "-1",
            title: `${title}\n${capability.id}\n${capability.description}`,
          },
          [
            el("span", { class: "capability-choice-title" }, [title]),
            el("br", { "aria-hidden": "true" }, []),
            el("code", { class: "capability-choice-id" }, [capability.id]),
          ],
        );
        const choice = {
          capability,
          button,
          searchText: [
            capability.title ?? "",
            capability.id,
            capability.description,
          ]
            .join("\n")
            .toLowerCase(),
        };
        choices.push(choice);
        button.addEventListener("click", () => {
          select(capability, button);
        });
        button.addEventListener("keydown", (event) => {
          const visibleChoices = choices.filter(
            ({ button: candidate }) => !candidate.hidden,
          );
          const currentIndex = visibleChoices.findIndex(
            ({ button: candidate }) => candidate === button,
          );
          if (currentIndex === -1 || visibleChoices.length === 0) return;

          let nextIndex: number | undefined;
          if (event.key === "ArrowDown") {
            nextIndex = (currentIndex + 1) % visibleChoices.length;
          } else if (event.key === "ArrowUp") {
            nextIndex =
              (currentIndex - 1 + visibleChoices.length) %
              visibleChoices.length;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = visibleChoices.length - 1;
          }
          if (nextIndex === undefined) return;

          event.preventDefault();
          const next = visibleChoices[nextIndex];
          if (next === undefined) return;
          select(next.capability, next.button);
          next.button.focus();
        });
      }

      const list = el(
        "div",
        {
          id: listId,
          class: "capability-list",
          role: "tablist",
          "aria-labelledby": sidebarHeadingId,
          "aria-orientation": "vertical",
        },
        choices.map(({ button }) => button),
      );

      const search = el(
        "input",
        {
          id: searchId,
          class: "capability-search",
          type: "search",
          placeholder: "Title, ID, or description",
          autocomplete: "off",
          "aria-controls": listId,
        },
        [],
      );
      const count = el(
        "p",
        {
          class: "capability-count",
          role: "status",
          "aria-live": "polite",
          "aria-atomic": "true",
        },
        [
          `${String(capabilities.length)} of ${String(capabilities.length)} ${capabilities.length === 1 ? "capability" : "capabilities"}`,
        ],
      );
      const filterEmpty = el(
        "p",
        { class: "empty capability-filter-empty", role: "status" },
        [
          "No capabilities match this search. The selected capability remains open.",
        ],
      );
      filterEmpty.hidden = true;

      const applyFilter = (): void => {
        const query = search.value.trim().toLowerCase();
        const visibleChoices = choices.filter((choice) => {
          const visible = query === "" || choice.searchText.includes(query);
          choice.button.hidden = !visible;
          return visible;
        });
        count.textContent = `${String(visibleChoices.length)} of ${String(capabilities.length)} ${capabilities.length === 1 ? "capability" : "capabilities"}`;
        filterEmpty.hidden = visibleChoices.length !== 0;

        if (visibleChoices.length === 0) {
          return;
        }

        const selectionStillVisible = visibleChoices.some(
          ({ button }) => button === selectedButton,
        );
        if (!selectionStillVisible) {
          const firstVisible = visibleChoices[0];
          if (firstVisible !== undefined) {
            select(firstVisible.capability, firstVisible.button);
          }
        }
      };
      search.addEventListener("input", applyFilter);

      const sidebar = el(
        "aside",
        {
          class: "capability-sidebar",
          "aria-labelledby": sidebarHeadingId,
        },
        [
          el(
            "h2",
            { id: sidebarHeadingId, class: "capability-sidebar-heading" },
            ["Capabilities"],
          ),
          count,
          el("label", { for: searchId, class: "capability-filter-label" }, [
            "Search capabilities",
          ]),
          search,
          list,
          filterEmpty,
        ],
      );
      container.append(
        el("div", { class: "capabilities-layout" }, [sidebar, detail]),
      );
      const first = choices[0];
      if (first !== undefined) {
        select(first.capability, first.button);
      }
    })
    .catch(() => {
      if (!active) return;
      clear(container);
      container.append(
        el("h2", {}, ["Capabilities"]),
        el("p", { class: "feedback", role: "alert" }, [
          "Couldn’t load capabilities. Check that the dev server is running, then reload.",
        ]),
      );
    });

  return () => {
    active = false;
  };
}
