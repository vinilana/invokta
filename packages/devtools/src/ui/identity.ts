import { el } from "./dom.js";
import {
  getActivePrincipalKey,
  listKnownPrincipals,
  onPrincipalChange,
  setActivePrincipal,
} from "./principals.js";

/**
 * The identity an emulated call acts as. Every adapter has one — it is what an
 * `access` rule sees — so this control is shown for all four. Acting
 * anonymously is a deliberate choice in the list, not a missing selection.
 */

const anonymousValue = "__anonymous__";

/**
 * Keyed by owner so a rebuilt panel replaces its registration, and one shared
 * subscription fans out to all of them.
 */
const painters = new Map<string, () => void>();
let subscribed = false;

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  onPrincipalChange(() => {
    for (const paint of painters.values()) {
      try {
        paint();
      } catch {
        // One panel failing to repaint must not stop the others.
      }
    }
  });
}

/** Only for tests: drops every panel registration. */
export function resetIdentitySelects(): void {
  painters.clear();
}

export interface IdentitySelect {
  readonly element: HTMLElement;
  setDisabled(disabled: boolean): void;
}

export function createIdentitySelect(owner: string): IdentitySelect {
  const select = el(
    "select",
    { class: "identity-select", "aria-label": "Identity" },
    [],
  );

  const paint = (): void => {
    const activeKey = getActivePrincipalKey();
    while (select.firstChild) select.firstChild.remove();
    for (const entry of listKnownPrincipals()) {
      select.append(el("option", { value: entry.key }, [entry.principal.id]));
    }
    select.append(
      el("option", { value: anonymousValue }, ["Anonymous (no principal)"]),
    );
    select.value = activeKey ?? anonymousValue;
  };

  select.addEventListener("change", () => {
    setActivePrincipal(select.value === anonymousValue ? null : select.value);
  });
  ensureSubscription();
  painters.set(owner, paint);
  paint();

  return {
    element: el("div", { class: "identity-control" }, [
      el("span", { class: "field-label" }, ["Identity"]),
      select,
    ]),
    setDisabled: (disabled) => {
      select.disabled = disabled;
    },
  };
}
