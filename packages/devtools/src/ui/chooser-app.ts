import { el } from "./dom.js";
import { createCompactThemeToggle, createThemeToggle } from "./theme.js";
import {
  createBrandLockup,
  type WorkbenchChoice,
  workbenchChoices,
  workbenchPaths,
} from "./workbench-chrome.js";

export { workbenchChoices } from "./workbench-chrome.js";

export interface ChooserAppHandle {
  destroy(): void;
}

function createChoice(choice: WorkbenchChoice): HTMLElement {
  return el(
    "a",
    {
      class: "att-choice",
      href: workbenchPaths[choice.workbench],
      "data-workbench": choice.workbench,
    },
    [
      el("p", { class: "att-kicker" }, ["Workbench"]),
      el("h2", {}, [choice.title]),
      el("p", { class: "att-choice-summary" }, [choice.summary]),
      el("p", { class: "att-hint" }, [choice.connects]),
      el("p", { class: "att-mono att-choice-flag" }, [choice.flag]),
    ],
  );
}

/**
 * The launcher landing page: which workbench to open. Neither one loads a
 * workspace, spawns a target, or opens an outbound connection until the
 * developer selects Connect inside it, so choosing here is free.
 */
export function mountChooserApp(root: HTMLElement): ChooserAppHandle {
  const ownerDocument = root.ownerDocument;
  ownerDocument.body.classList.add("attached-mode");
  const rails = el(
    "div",
    { class: "att-rails", "aria-hidden": "true" },
    Array.from({ length: 5 }, () => el("span", {}, [])),
  );
  const topbar = el("header", { class: "att-topbar" }, [
    el("div", { class: "att-frame att-topbar-inner" }, [
      createBrandLockup(),
      el("span", { class: "att-topbar-spacer", "aria-hidden": "true" }, []),
      el("div", { class: "att-theme-slot att-theme-slot-full" }, [
        createThemeToggle(),
      ]),
      el("div", { class: "att-theme-slot att-theme-slot-compact" }, [
        createCompactThemeToggle(),
      ]),
    ]),
  ]);
  const context = el("section", { class: "att-context" }, [
    el("div", { class: "att-frame att-context-inner" }, [
      el("div", { class: "att-context-title" }, [
        el("p", { class: "att-kicker" }, ["Invokta DevTools"]),
        el("h1", {}, ["Choose a workbench"]),
      ]),
      el("div", { class: "att-context-meta" }, [
        el("span", { class: "att-pill" }, ["Idle"]),
      ]),
    ]),
  ]);
  const main = el("main", { class: "att-frame att-main" }, [
    el(
      "div",
      { class: "att-choices" },
      workbenchChoices.map((choice) => createChoice(choice)),
    ),
    el("aside", { class: "att-card att-choice-note" }, [
      el("h3", {}, ["Working on an engine in this repository?"]),
      el("p", {}, [
        "Neither workbench loads a workspace. Serve the built engine instead:",
      ]),
      el("p", { class: "att-mono" }, ["invokta-devtools serve dist/engine.js"]),
      el("p", { class: "att-hint" }, [
        "or yarn devtools inside an engine repo",
      ]),
    ]),
  ]);
  root.replaceChildren(
    el("div", { class: "att-shell" }, [rails, topbar, context, main]),
  );
  root.querySelector<HTMLElement>(".att-choice")?.focus();

  return {
    destroy() {
      root.replaceChildren();
      ownerDocument.body.classList.remove("attached-mode");
    },
  };
}

if (typeof document !== "undefined") {
  const start = (): void => {
    mountChooserApp(document.body);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
