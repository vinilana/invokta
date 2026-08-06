import { el } from "./dom.js";

export type ThemeChoice = "dark" | "light" | "auto";
type ResolvedTheme = Exclude<ThemeChoice, "auto">;

const themeStorageKey = "starlight-theme";
const systemThemeQuery = "(prefers-color-scheme: light)";
const choices: ReadonlyArray<{
  readonly value: ThemeChoice;
  readonly label: string;
  readonly icon: string;
}> = [
  { value: "dark", label: "Dark", icon: "◐" },
  { value: "light", label: "Light", icon: "☼" },
  { value: "auto", label: "Auto", icon: "▣" },
];

function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "dark" || value === "light" || value === "auto";
}

function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return isThemeChoice(stored) ? stored : "dark";
  } catch {
    return "dark";
  }
}

function systemTheme(): ResolvedTheme {
  try {
    return matchMedia(systemThemeQuery).matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function resolvedTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "auto" ? systemTheme() : choice;
}

/**
 * Mirrors the Invokta site theme choices and storage key. The preference is
 * reused on repeat visits to this origin; localStorage does not cross origins.
 */
export function createThemeToggle(): HTMLElement {
  let selected = readThemeChoice();
  const buttons = new Map<ThemeChoice, HTMLButtonElement>();

  const paint = (): void => {
    document.documentElement.dataset.theme = resolvedTheme(selected);
    for (const [choice, button] of buttons) {
      const checked = choice === selected;
      button.setAttribute("aria-checked", String(checked));
      button.setAttribute("tabindex", checked ? "0" : "-1");
    }
  };

  const select = (choice: ThemeChoice, focus = false): void => {
    selected = choice;
    try {
      localStorage.setItem(themeStorageKey, choice);
    } catch {
      // The in-memory preference still applies when storage is unavailable.
    }
    paint();
    if (focus) buttons.get(choice)?.focus();
  };

  const group = el(
    "div",
    { class: "theme-toggle", role: "radiogroup", "aria-label": "Color theme" },
    choices.map(({ value, label, icon }) => {
      const button = el(
        "button",
        {
          type: "button",
          role: "radio",
          "aria-label": label,
          title: label,
        },
        [el("span", { "aria-hidden": "true" }, [icon])],
      );
      button.addEventListener("click", () => {
        select(value);
      });
      buttons.set(value, button);
      return button;
    }),
  );

  group.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const current = choices.findIndex(({ value }) => value === selected);
    if (current < 0) return;

    let nextIndex = current;
    if (
      keyboardEvent.key === "ArrowRight" ||
      keyboardEvent.key === "ArrowDown"
    ) {
      nextIndex = current + 1;
    } else if (
      keyboardEvent.key === "ArrowLeft" ||
      keyboardEvent.key === "ArrowUp"
    ) {
      nextIndex = current - 1;
    } else if (keyboardEvent.key === "Home") {
      nextIndex = 0;
    } else if (keyboardEvent.key === "End") {
      nextIndex = choices.length - 1;
    } else {
      return;
    }

    keyboardEvent.preventDefault();
    const next = choices.at((nextIndex + choices.length) % choices.length);
    if (next !== undefined) select(next.value, true);
  });

  try {
    matchMedia(systemThemeQuery).addEventListener("change", () => {
      if (selected === "auto") paint();
    });
  } catch {
    // Older browsers keep the last resolved theme.
  }

  paint();
  return group;
}
