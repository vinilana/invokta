import { CliApiError, createRouteCliApi } from "./cli-api.js";
import {
  type CliCurrentResult,
  createCliCommandsPanel,
} from "./cli-command-view.js";
import {
  cliActivityTable,
  cliErrorMessage,
  cliStatusPill,
  createCliBrandMark,
} from "./cli-components.js";
import {
  type CliActivityRecord,
  type CliApi,
  type CliCapabilityDescription,
  type CliCapabilitySummary,
  type CliConnectionState,
  refreshFailureIsDisconnect,
  retainedActivityOf,
} from "./cli-contract.js";
import {
  createCliIdleView,
  createCliUnavailableView,
  type EditableCliTargetDraft,
} from "./cli-connection-view.js";
import { el } from "./dom.js";
import { createCompactThemeToggle, createThemeToggle } from "./theme.js";

export type {
  CliActivityRecord,
  CliApi,
  CliCapabilityDescription,
  CliCapabilitySummary,
  CliConnectionState,
  CliConnectionSummary,
  CliJsonValue,
  CliSession,
  CliTarget,
  CliTargetDraft,
  SecretControl,
} from "./cli-contract.js";
export {
  buildCliTarget,
  completeConnectionAttempt,
  nextRovingIndex,
  parseRunInput,
  refreshFailureIsDisconnect,
  retainedActivityOf,
  seedCliInput,
} from "./cli-contract.js";
export { CliApiError, createRouteCliApi } from "./cli-api.js";

export const cliPrimaryTabs = ["Commands", "Activity", "Connection"] as const;

type CliTab = "commands" | "activity" | "connection";

const activityPollDelayMs = 5_000;

export interface CliAppHandle {
  destroy(): void;
}

export function mountCliApp(
  root: HTMLElement,
  api: CliApi = createRouteCliApi(),
): CliAppHandle {
  const ownerDocument = root.ownerDocument;
  ownerDocument.body.classList.add("attached-mode");
  if (
    ownerDocument.head.querySelector('link[href="/assets/attached.css"]') ===
    null
  ) {
    ownerDocument.head.append(
      el("link", {
        rel: "stylesheet",
        href: "/assets/attached.css",
      }),
    );
  }

  let destroyed = false;
  let targetState: CliConnectionState = { state: "idle" };
  let activeTab: CliTab = "commands";
  let commands: readonly CliCapabilitySummary[] = [];
  let commandsLoaded = false;
  let commandsLoading = false;
  let commandsError = "";
  let selectedId: string | undefined;
  let described: CliCapabilityDescription | undefined;
  let describeError = "";
  let commandQuery = "";
  let activity: readonly CliActivityRecord[] = [];
  let activityLoaded = false;
  let activityLoading = false;
  let activityError = "";
  let activityPoll: ReturnType<typeof setInterval> | undefined;
  let connectionError = "";
  let secretConfigured = false;
  const draft: EditableCliTargetDraft = {
    command: "",
    args: [],
    cwd: "",
    environment: [],
  };
  const fullThemeToggle = createThemeToggle();
  const compactThemeToggle = createCompactThemeToggle();
  const argumentDrafts = new Map<string, string>();
  let currentResult: CliCurrentResult | undefined;

  const render = (): void => {
    if (destroyed) return;
    if (targetState.state === "idle") {
      shell(
        createCliIdleView({
          state: targetState,
          draft,
          connectionError,
          connect: (target) => api.connect(target),
          connected(state, carriesSecrets) {
            targetState = state;
            secretConfigured = carriesSecrets;
            connectionError = "";
            render();
            if (
              targetState.state === "connected" &&
              targetState.connection !== undefined
            ) {
              void loadCatalog();
            }
          },
        }),
        false,
      );
    } else if (
      targetState.state === "connected" &&
      targetState.connection !== undefined
    ) {
      renderConnected();
    } else {
      shell(createCliUnavailableView(targetState), false);
    }
  };

  const createTabs = (): HTMLElement => {
    const buttons: HTMLButtonElement[] = [];
    const nav = el(
      "nav",
      {
        class: "att-tabs",
        role: "tablist",
        "aria-label": "CLI workbench sections",
        "aria-orientation": "horizontal",
      },
      cliPrimaryTabs.map((label) => {
        const name = label.toLowerCase() as CliTab;
        const button = el(
          "button",
          {
            type: "button",
            role: "tab",
            id: `cli-tab-${name}`,
            "aria-controls": `cli-panel-${name}`,
            "aria-selected": String(activeTab === name),
            tabindex: activeTab === name ? "0" : "-1",
          },
          [label],
        );
        button.addEventListener("click", () => {
          void selectTab(name);
        });
        buttons.push(button);
        return button;
      }),
    );
    nav.addEventListener("keydown", (event) => {
      const current = buttons.indexOf(event.target as HTMLButtonElement);
      if (current < 0) return;
      let next = current;
      if (event.key === "ArrowRight") next += 1;
      else if (event.key === "ArrowLeft") next -= 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else return;
      event.preventDefault();
      const destination = buttons.at((next + buttons.length) % buttons.length);
      const tab = cliPrimaryTabs.at(
        (next + cliPrimaryTabs.length) % cliPrimaryTabs.length,
      );
      if (destination === undefined || tab === undefined) return;
      void selectTab(tab.toLowerCase() as CliTab).then(() => {
        ownerDocument.getElementById(destination.id)?.focus();
      });
    });
    return nav;
  };

  const shell = (content: HTMLElement, includeTabs: boolean): void => {
    const brand = el("div", { class: "att-brand" }, [
      createCliBrandMark(),
      el("span", { class: "att-brand-name" }, ["invokta"]),
      el("span", { class: "att-product-name" }, ["DevTools"]),
    ]);
    const topbarChildren: Node[] = [brand];
    if (includeTabs) topbarChildren.push(createTabs());
    else {
      topbarChildren.push(
        el("span", { class: "att-topbar-spacer", "aria-hidden": "true" }, []),
      );
    }
    topbarChildren.push(
      el("div", { class: "att-theme-slot att-theme-slot-full" }, [
        fullThemeToggle,
      ]),
      el("div", { class: "att-theme-slot att-theme-slot-compact" }, [
        compactThemeToggle,
      ]),
    );
    const rails = el(
      "div",
      { class: "att-rails", "aria-hidden": "true" },
      Array.from({ length: 5 }, () => el("span", {}, [])),
    );
    const topbar = el("header", { class: "att-topbar" }, [
      el("div", { class: "att-frame att-topbar-inner" }, topbarChildren),
    ]);
    const heading =
      targetState.state === "connected" && targetState.connection !== undefined
        ? targetState.connection.command
        : "CLI workbench";
    const context = el("section", { class: "att-context" }, [
      el("div", { class: "att-frame att-context-inner" }, [
        el("div", { class: "att-context-title" }, [
          el("p", { class: "att-kicker" }, ["CLI workbench"]),
          el("h1", {}, [heading]),
        ]),
        el("div", { class: "att-context-meta" }, [
          cliStatusPill(targetState),
          ...(targetState.state === "connected" &&
          targetState.connection !== undefined
            ? [
                el("span", { class: "att-pill" }, [
                  `${String(targetState.connection.capabilityCount)} commands`,
                ]),
              ]
            : []),
        ]),
      ]),
    ]);
    const main = el("main", { class: "att-frame att-main" }, [content]);
    root.replaceChildren(
      el("div", { class: "att-shell" }, [rails, topbar, context, main]),
    );
  };

  function renderConnected(): void {
    let panel: HTMLElement;
    if (activeTab === "activity") panel = renderActivityPanel();
    else if (activeTab === "connection") panel = renderConnectionPanel();
    else {
      panel = createCliCommandsPanel({
        root,
        api,
        commands,
        commandsLoaded,
        commandsLoading,
        commandsError,
        selectedId,
        described,
        describeError,
        commandQuery,
        argumentDrafts,
        currentResult,
        retryCatalog: () => void loadCatalog(),
        setSelectedId: (id) => {
          selectedId = id;
        },
        selectCommand(id) {
          selectedId = id;
          described = undefined;
          describeError = "";
          render();
          void loadDescribe(id);
        },
        setCommandQuery: (query) => {
          commandQuery = query;
        },
        setCurrentResult: (value) => {
          currentResult = value;
        },
        markActivityStale: () => {
          activityLoaded = false;
        },
      });
    }
    panel.id = `cli-panel-${activeTab}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `cli-tab-${activeTab}`);
    panel.setAttribute("tabindex", "0");
    shell(el("div", { class: "att-card att-workbench" }, [panel]), true);
  }

  function renderActivityPanel(): HTMLElement {
    const refresh = el("button", { type: "button", class: "att-button" }, [
      "Refresh",
    ]);
    refresh.disabled = activityLoading;
    refresh.addEventListener("click", () => void loadActivity());
    const content: Node[] = [
      el("div", { class: "att-section-heading" }, [
        el("div", {}, [
          el("h2", {}, ["Activity"]),
          el("span", { class: "att-hint" }, [
            "Verb, id, exit, duration, and outcome only",
          ]),
        ]),
        refresh,
      ]),
    ];
    if (activityLoading && !activityLoaded) {
      content.push(el("p", { class: "att-hint" }, ["Loading activity…"]));
    } else if (activityError !== "") {
      content.push(
        el("p", { class: "att-feedback", role: "alert" }, [activityError]),
      );
    } else if (activity.length === 0) {
      content.push(
        el("div", { class: "att-empty" }, [
          "No CLI verbs have been recorded for this connection.",
        ]),
      );
    } else {
      content.push(cliActivityTable(activity));
    }
    return el("section", { class: "att-view" }, content);
  }

  function renderConnectionPanel(): HTMLElement {
    if (
      targetState.state !== "connected" ||
      targetState.connection === undefined
    ) {
      return el("section", { class: "att-view" }, [
        el("div", { class: "att-empty" }, [
          "Connection details are unavailable.",
        ]),
      ]);
    }
    const summary = targetState.connection;
    const disconnect = el(
      "button",
      { type: "button", class: "att-button danger" },
      ["Disconnect"],
    );
    const refresh = el("button", { type: "button", class: "att-button" }, [
      "Refresh catalog",
    ]);
    const feedback = el("p", {
      class: "att-feedback",
      role: "alert",
      "aria-live": "assertive",
    });
    feedback.textContent = connectionError;
    disconnect.addEventListener("click", () => {
      disconnect.disabled = true;
      disconnect.textContent = "Disconnecting…";
      void api
        .disconnect()
        .then((state) => {
          targetState = state;
          commands = [];
          commandsLoaded = false;
          activity = [];
          activityLoaded = false;
          selectedId = undefined;
          described = undefined;
          currentResult = undefined;
          argumentDrafts.clear();
          secretConfigured = false;
          connectionError = "";
          activeTab = "commands";
          stopActivityPolling();
          render();
        })
        .catch((error: unknown) => {
          disconnect.disabled = false;
          disconnect.textContent = "Disconnect";
          feedback.textContent = cliErrorMessage(error);
        });
    });
    refresh.addEventListener("click", () => {
      refresh.disabled = true;
      void api
        .refresh()
        .then((state) => {
          targetState = state;
          described = undefined;
          selectedId = undefined;
          currentResult = undefined;
          argumentDrafts.clear();
          connectionError = "";
          void loadCatalog();
        })
        .catch((error: unknown) => {
          const code = error instanceof CliApiError ? error.code : undefined;
          const message = cliErrorMessage(error);
          if (!refreshFailureIsDisconnect(code)) {
            feedback.textContent = message;
            return;
          }
          connectionError = message;
          targetState = {
            state: "idle",
            validation: {
              status: "error",
              error: {
                code: code ?? "CONNECTION_FAILED",
                message,
              },
            },
          };
          commands = [];
          commandsLoaded = false;
          described = undefined;
          currentResult = undefined;
          selectedId = undefined;
          argumentDrafts.clear();
          stopActivityPolling();
          render();
        })
        .finally(() => {
          refresh.disabled = false;
        });
    });
    const item = (label: string, value: string): HTMLElement =>
      el("div", { class: "att-summary-item" }, [
        el("span", { class: "att-summary-label" }, [label]),
        el("span", { class: "att-summary-value" }, [value]),
      ]);
    return el("section", { class: "att-view" }, [
      el("div", { class: "att-section-heading" }, [
        el("div", {}, [
          el("h2", {}, ["Connection"]),
          el("span", { class: "att-hint" }, [
            "Sanitized validation details for the attached CLI",
          ]),
        ]),
        el("div", { class: "att-actions" }, [refresh, disconnect]),
      ]),
      el("div", { class: "att-summary-grid" }, [
        item("Command", summary.command),
        item("Validation", "list complete"),
        item("Commands", String(summary.capabilityCount)),
      ]),
      el("div", { class: "att-callout" }, [
        secretConfigured
          ? "Sensitive values •••••••• configured in process memory."
          : "Environment values are never returned to this page.",
      ]),
      feedback,
    ]);
  }

  async function selectTab(name: CliTab): Promise<void> {
    activeTab = name;
    if (name === "activity") startActivityPolling();
    else stopActivityPolling();
    render();
    if (name === "activity") await loadActivity();
  }

  const stopActivityPolling = (): void => {
    if (activityPoll !== undefined) clearInterval(activityPoll);
    activityPoll = undefined;
  };

  const startActivityPolling = (): void => {
    stopActivityPolling();
    activityPoll = setInterval(() => {
      if (destroyed || activeTab !== "activity") {
        stopActivityPolling();
        return;
      }
      void loadActivity();
    }, activityPollDelayMs);
  };

  async function loadCatalog(): Promise<void> {
    if (commandsLoading) return;
    commandsLoading = true;
    commandsError = "";
    render();
    try {
      commands = await api.catalog();
      commandsLoaded = true;
      if (selectedId === undefined) selectedId = commands[0]?.id;
      if (selectedId !== undefined) void loadDescribe(selectedId);
    } catch (error) {
      commandsError = cliErrorMessage(error);
    } finally {
      commandsLoading = false;
      render();
    }
  }

  async function loadDescribe(id: string): Promise<void> {
    describeError = "";
    try {
      described = await api.describe(id);
    } catch (error) {
      described = undefined;
      describeError = cliErrorMessage(error);
    } finally {
      render();
    }
  }

  async function loadActivity(): Promise<void> {
    if (activityLoading) return;
    activityLoading = true;
    activityError = "";
    render();
    try {
      activity = await api.activity();
      activityLoaded = true;
    } catch (error) {
      activityError = cliErrorMessage(error);
    } finally {
      activityLoading = false;
      render();
    }
  }

  let shortcutsOverlay: HTMLElement | undefined;
  let shortcutsOpener: HTMLElement | undefined;
  const closeShortcuts = (): void => {
    if (shortcutsOverlay === undefined) return;
    shortcutsOverlay.remove();
    shortcutsOverlay = undefined;
    shortcutsOpener?.focus();
    shortcutsOpener = undefined;
  };
  const shortcutEntry = (keys: string, action: string): HTMLElement =>
    el("div", { class: "att-shortcuts-entry" }, [
      el("dt", {}, [el("kbd", {}, [keys])]),
      el("dd", {}, [action]),
    ]);
  const toggleShortcuts = (): void => {
    if (shortcutsOverlay !== undefined) {
      closeShortcuts();
      return;
    }
    const card = el("div", { class: "att-shortcuts-card", tabindex: "-1" }, [
      el("h2", { id: "cli-shortcuts-title" }, ["Keyboard shortcuts"]),
      el("dl", { class: "att-shortcuts-list" }, [
        shortcutEntry("Ctrl/⌘ + Enter", "Run the selected command"),
        shortcutEntry("← →", "Move between tabs"),
        shortcutEntry("?", "Toggle this overlay"),
      ]),
      el("p", { class: "att-hint" }, ["Press ? or Escape to close."]),
    ]);
    const overlay = el(
      "div",
      {
        class: "att-shortcuts-overlay",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "cli-shortcuts-title",
      },
      [card],
    );
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeShortcuts();
    });
    shortcutsOverlay = overlay;
    const previous: unknown = ownerDocument.activeElement;
    shortcutsOpener =
      typeof previous === "object" &&
      previous !== null &&
      previous !== ownerDocument.body &&
      typeof (previous as { focus?: unknown }).focus === "function"
        ? (previous as HTMLElement)
        : undefined;
    ownerDocument.body.append(overlay);
    card.focus();
  };
  const onShortcutKeydown = (event: KeyboardEvent): void => {
    if (destroyed) return;
    if (event.key === "Escape" && shortcutsOverlay !== undefined) {
      closeShortcuts();
      event.preventDefault();
      return;
    }
    if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const tagName = target?.tagName;
    if (
      tagName === "INPUT" ||
      tagName === "TEXTAREA" ||
      target?.isContentEditable === true
    ) {
      return;
    }
    event.preventDefault();
    toggleShortcuts();
  };
  ownerDocument.body.addEventListener("keydown", onShortcutKeydown);

  shell(
    el("section", { class: "att-card att-loading" }, ["Opening workbench…"]),
    false,
  );
  void api
    .session()
    .then((session) => {
      const retained = retainedActivityOf(session);
      targetState =
        session.state === "connected"
          ? {
              state: "connected",
              ...(session.connection === undefined
                ? {}
                : { connection: session.connection }),
            }
          : session.state === "idle"
            ? {
                state: "idle",
                ...(session.validation === undefined
                  ? {}
                  : { validation: session.validation }),
                ...(retained.length === 0 ? {} : { activity: retained }),
              }
            : { state: session.state };
      connectionError =
        targetState.state === "idle"
          ? (targetState.validation?.error.message ?? "")
          : "";
      render();
      if (
        targetState.state === "connected" &&
        targetState.connection !== undefined
      ) {
        void loadCatalog();
      }
    })
    .catch((error: unknown) => {
      targetState = { state: "idle" };
      render();
      const alert = root.querySelector<HTMLElement>(".att-feedback");
      if (alert !== null) alert.textContent = cliErrorMessage(error);
    });

  return {
    destroy() {
      destroyed = true;
      closeShortcuts();
      ownerDocument.body.removeEventListener("keydown", onShortcutKeydown);
      stopActivityPolling();
      root.replaceChildren();
      ownerDocument.body.classList.remove("attached-mode");
    },
  };
}

if (typeof document !== "undefined") {
  const start = (): void => {
    mountCliApp(document.body);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
