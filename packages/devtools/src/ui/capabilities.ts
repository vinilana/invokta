import { api, type CapabilityInfo } from "./api.js";
import { type Child, clear, el } from "./dom.js";
import { renderInvokePanel } from "./invoke-panel.js";
import { renderSchemaView } from "./schema-view.js";

function capabilityTitle(capability: CapabilityInfo): string {
  const title = capability.title?.trim();
  return title === undefined || title === "" ? "Untitled capability" : title;
}

/** Reads the capability id from a `#capabilities/<id>` deep link. */
function capabilityFromHash(): string | undefined {
  try {
    if (typeof location === "undefined") return undefined;
    const [route, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
    if (route !== "capabilities" || rest.length === 0) return undefined;
    const id = decodeURIComponent(rest.join("/"));
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
}

let mountedSearch: HTMLInputElement | undefined;

/**
 * Moves focus to the catalog filter of the mounted Playground so the shell can
 * offer one search shortcut without reaching into this panel's DOM. Returns
 * whether a filter was available to focus.
 */
export function focusCapabilitySearch(): boolean {
  if (mountedSearch === undefined) return false;
  mountedSearch.focus();
  mountedSearch.select();
  return true;
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
  let loading = false;
  let ownedSearch: HTMLInputElement | undefined;
  // One registration for the panel's lifetime. Each successful load swaps the
  // handler it delegates to, so a repeated Retry cannot stack listeners that
  // still close over a detached catalog.
  let selectCapabilityById: ((id: string) => void) | undefined;
  const selectListener = (event: Event): void => {
    const id = (event as CustomEvent<{ readonly id?: unknown }>).detail?.id;
    if (typeof id === "string") selectCapabilityById?.(id);
  };
  const documentListens = typeof document.addEventListener === "function";
  if (documentListens) {
    document.addEventListener("invokta:select-capability", selectListener);
  }

  const load = (): void => {
    if (loading) return;
    loading = true;
    clear(container);
    container.append(
      el("h2", {}, ["Capabilities"]),
      el("p", { class: "hint", role: "status" }, [
        "Loading capability catalog…",
      ]),
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
          detail.setAttribute(
            "aria-labelledby",
            button.getAttribute("id") ?? "",
          );
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
          // The open detail stays put even when the filter hides the selected
          // capability, matching the filterEmpty hint.
        };
        search.addEventListener("input", applyFilter);
        search.addEventListener("keydown", (event) => {
          if (event.key !== "Escape" || search.value === "") return;
          event.preventDefault();
          search.value = "";
          applyFilter();
        });
        ownedSearch = search;
        mountedSearch = search;

        // Activity and Diagnostics hand a capability over with this event;
        // treat it like a sidebar click, clearing the filter so the row stays
        // visible.
        selectCapabilityById = (id: string): void => {
          const match = choices.find(({ capability }) => capability.id === id);
          if (match === undefined || match.button === selectedButton) return;
          search.value = "";
          applyFilter();
          select(match.capability, match.button);
        };

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
              el("span", { class: "capability-filter-shortcut" }, [
                el("kbd", {}, ["/"]),
              ]),
            ]),
            search,
            list,
            filterEmpty,
          ],
        );
        container.append(
          el("div", { class: "capabilities-layout" }, [sidebar, detail]),
        );
        // A shared `#capabilities/<id>` link opens on its capability.
        const deepLinked = capabilityFromHash();
        const initial =
          (deepLinked === undefined
            ? undefined
            : choices.find(({ capability }) => capability.id === deepLinked)) ??
          choices[0];
        if (initial !== undefined) {
          select(initial.capability, initial.button);
        }
      })
      .catch(() => {
        if (!active) return;
        clear(container);
        const retry = el(
          "button",
          { type: "button", class: "capability-retry" },
          ["Retry"],
        );
        retry.addEventListener("click", () => {
          load();
        });
        container.append(
          el("h2", {}, ["Capabilities"]),
          el("p", { class: "feedback", role: "alert" }, [
            "Couldn’t load capabilities. Check that the dev server is running, then try again.",
          ]),
          retry,
        );
      })
      .finally(() => {
        loading = false;
      });
  };

  load();

  return () => {
    active = false;
    selectCapabilityById = undefined;
    if (mountedSearch === ownedSearch) mountedSearch = undefined;
    if (documentListens && typeof document.removeEventListener === "function") {
      document.removeEventListener("invokta:select-capability", selectListener);
    }
  };
}
