import { api, type HttpTargetView } from "./api.js";
import { el } from "./dom.js";

/**
 * Where MCP HTTP sends a call and how it authenticates, chartered by ADR 0028.
 * The devtools host authenticates with its own minted session tokens, so it
 * offers those two choices only; an external endpoint is the developer's own
 * server, so it offers what a real HTTP boundary accepts.
 *
 * The selection belongs to the dev server, not to one capability panel, so it
 * is held here and every panel follows it.
 */

export type HttpAuthChoice =
  | "devtools-session-token"
  | "devtools-none"
  | "external";

const authorizationPollMs = 1_500;
const authorizationPollAttempts = 80;

let current: HttpTargetView = {
  kind: "devtools",
  authentication: { type: "session-token" },
};
let loaded = false;

/** Keyed by owner so a rebuilt panel replaces its registration. */
const listeners = new Map<string, (target: HttpTargetView) => void>();

function publish(): void {
  for (const listener of listeners.values()) {
    try {
      listener(current);
    } catch {
      // One panel failing to follow must not stop the others.
    }
  }
}

export function getHttpTarget(): HttpTargetView {
  return current;
}

/** Only for tests: forgets the cached selection and every registration. */
export function resetHttpTarget(): void {
  current = { kind: "devtools", authentication: { type: "session-token" } };
  loaded = false;
  listeners.clear();
}

/** An answer that is not a target view leaves the current selection alone. */
function isHttpTargetView(value: unknown): value is HttpTargetView {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    readonly kind?: unknown;
    readonly authentication?: unknown;
  };
  if (record.kind !== "devtools" && record.kind !== "external") return false;
  return (
    typeof record.authentication === "object" &&
    record.authentication !== null &&
    typeof (record.authentication as { readonly type?: unknown }).type ===
      "string"
  );
}

export async function loadHttpTarget(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const view: unknown = await api.httpTarget();
    if (!isHttpTargetView(view)) return;
    current = view;
    publish();
  } catch {
    // The default selection stays; invoking will report the real failure.
  }
}

export function describeHttpTarget(target: HttpTargetView): string {
  const type = target.authentication?.type;
  if (target.kind !== "external") {
    return type === "none"
      ? "Devtools host · no credential"
      : "Devtools host · session token";
  }
  const authentication =
    type === "oauth"
      ? target.authentication.authorized === true
        ? "OAuth · authorized"
        : "OAuth · not authorized"
      : type === "bearer"
        ? "Bearer"
        : type === "headers"
          ? "Custom headers"
          : "No credential";
  return `${target.url ?? "External endpoint"} · ${authentication}`;
}

/**
 * Reads a credential the way `verify` does: a value that names an environment
 * variable keeps the secret in the dev server's environment instead of the
 * browser.
 */
function credentialFrom(value: string): unknown {
  const trimmed = value.trim();
  return trimmed.startsWith("$")
    ? { kind: "environment", name: trimmed.slice(1) }
    : { kind: "literal", value: trimmed };
}

interface HeaderRow {
  readonly row: HTMLElement;
  readonly name: HTMLInputElement;
  readonly value: HTMLInputElement;
}

export interface HttpAuthControl {
  readonly element: HTMLElement;
  setDisabled(disabled: boolean): void;
}

export function createHttpAuthControl(owner: string): HttpAuthControl {
  const summary = el("span", { class: "auth-summary" }, [
    describeHttpTarget(current),
  ]);
  const choice = el(
    "select",
    { class: "auth-choice", "aria-label": "Authentication" },
    [
      el("option", { value: "devtools-session-token" }, [
        "Devtools host · session token",
      ]),
      el("option", { value: "devtools-none" }, [
        "Devtools host · no credential",
      ]),
      el("option", { value: "external" }, ["External endpoint…"]),
    ],
  );
  const feedback = el(
    "p",
    { class: "auth-feedback", "aria-live": "polite" },
    [],
  );

  const url = el("input", {
    type: "url",
    class: "auth-url",
    placeholder: "https://127.0.0.1:3000/mcp",
    "aria-label": "Endpoint URL",
    spellcheck: "false",
  });
  const externalType = el(
    "select",
    { class: "auth-external-type", "aria-label": "Credential" },
    [
      el("option", { value: "none" }, ["No credential"]),
      el("option", { value: "bearer" }, ["Bearer token"]),
      el("option", { value: "headers" }, ["Custom headers"]),
      el("option", { value: "oauth" }, ["OAuth"]),
    ],
  );
  const bearer = el("input", {
    type: "text",
    class: "auth-credential",
    placeholder: "Token, or $ENV_VAR to read it from the environment",
    "aria-label": "Bearer token",
    spellcheck: "false",
  });
  const headerRows: HeaderRow[] = [];
  const headerList = el("div", { class: "auth-headers" }, []);
  const addHeader = el("button", { type: "button", class: "auth-add-header" }, [
    "Add header",
  ]);
  const apply = el("button", { type: "button", class: "primary" }, [
    "Use endpoint",
  ]);
  const cancel = el("button", { type: "button" }, ["Cancel"]);
  const form = el("div", { class: "auth-form" }, [
    el("label", { class: "field-label" }, ["Endpoint URL"]),
    url,
    el("div", { class: "auth-form-row" }, [
      el("label", { class: "field-label" }, ["Credential"]),
      externalType,
    ]),
    bearer,
    headerList,
    addHeader,
    el("div", { class: "auth-form-actions" }, [apply, cancel]),
    el("p", { class: "hint" }, [
      "Plain HTTP is accepted only for loopback. A value starting with $ names an environment variable the dev server reads, so the secret never leaves it.",
    ]),
  ]);
  form.hidden = true;

  const createHeaderRow = (): HeaderRow => {
    const name = el("input", {
      type: "text",
      class: "auth-header-name",
      placeholder: "X-API-Key",
      "aria-label": "Header name",
      spellcheck: "false",
    });
    const value = el("input", {
      type: "text",
      class: "auth-header-value",
      placeholder: "Value, or $ENV_VAR",
      "aria-label": "Header value",
      spellcheck: "false",
    });
    const remove = el(
      "button",
      {
        type: "button",
        class: "auth-remove-header",
        "aria-label": "Remove header",
      },
      ["Remove"],
    );
    const row = el("div", { class: "auth-header-row" }, [name, value, remove]);
    const entry: HeaderRow = { row, name, value };
    remove.addEventListener("click", () => {
      const index = headerRows.indexOf(entry);
      if (index !== -1) headerRows.splice(index, 1);
      row.remove();
      if (headerRows.length === 0) headerList.append(createHeaderRow().row);
    });
    headerRows.push(entry);
    return entry;
  };
  headerList.append(createHeaderRow().row);
  addHeader.addEventListener("click", () => {
    if (headerRows.length >= 8) return;
    headerList.append(createHeaderRow().row);
  });

  const paintFormFields = (): void => {
    const type = externalType.value;
    bearer.hidden = type !== "bearer";
    headerList.hidden = type !== "headers";
    addHeader.hidden = type !== "headers";
    apply.textContent = type === "oauth" ? "Authorize" : "Use endpoint";
  };
  externalType.addEventListener("change", paintFormFields);
  paintFormFields();

  const paint = (target: HttpTargetView): void => {
    summary.textContent = describeHttpTarget(target);
    choice.value =
      target.kind === "external"
        ? "external"
        : target.authentication?.type === "none"
          ? "devtools-none"
          : "devtools-session-token";
    summary.hidden = target.kind !== "external";
  };

  const send = async (body: unknown): Promise<void> => {
    feedback.textContent = "";
    try {
      const next = await api.setHttpTarget(body);
      current = next.target;
      publish();
      if (next.authorizationUrl === undefined) {
        form.hidden = true;
        return;
      }
      feedback.textContent =
        "Continue in the new tab, then return here. Waiting for authorization…";
      try {
        globalThis.open?.(next.authorizationUrl, "_blank", "noopener");
      } catch {
        feedback.textContent = `Open ${next.authorizationUrl} to authorize, then return here.`;
      }
      for (let attempt = 0; attempt < authorizationPollAttempts; attempt += 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, authorizationPollMs),
        );
        const view = await api.httpTarget().catch(() => undefined);
        if (view === undefined) continue;
        current = view;
        publish();
        if (view.authentication.authorized === true) {
          feedback.textContent = "Authorized.";
          form.hidden = true;
          return;
        }
      }
      feedback.textContent =
        "The authorization did not complete. Try again from this form.";
    } catch (error) {
      feedback.textContent =
        error instanceof Error
          ? error.message
          : "The endpoint could not be selected.";
    }
  };

  choice.addEventListener("change", () => {
    if (choice.value === "external") {
      form.hidden = false;
      url.focus();
      return;
    }
    form.hidden = true;
    void send({
      kind: "devtools",
      authentication: {
        type: choice.value === "devtools-none" ? "none" : "session-token",
      },
    });
  });

  cancel.addEventListener("click", () => {
    form.hidden = true;
    feedback.textContent = "";
    paint(current);
  });

  apply.addEventListener("click", () => {
    const type = externalType.value;
    const authentication =
      type === "bearer"
        ? { type, token: credentialFrom(bearer.value) }
        : type === "headers"
          ? {
              type,
              headers: headerRows
                .filter((entry) => entry.name.value.trim() !== "")
                .map((entry) => ({
                  name: entry.name.value.trim(),
                  value: credentialFrom(entry.value.value),
                })),
            }
          : { type };
    void send({ kind: "external", url: url.value.trim(), authentication });
  });

  // The selection belongs to the session, not to this panel: the shell loads
  // it once at boot and every panel follows the published value.
  listeners.set(owner, paint);
  paint(current);

  const element = el("div", { class: "auth-control" }, [
    el("span", { class: "field-label" }, ["Auth"]),
    choice,
    summary,
    form,
    feedback,
  ]);

  return {
    element,
    setDisabled: (disabled) => {
      choice.disabled = disabled;
      apply.disabled = disabled;
    },
  };
}
