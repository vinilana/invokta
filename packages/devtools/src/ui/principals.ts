import { api, type PrincipalInfo } from "./api.js";
import { clear, el, pretty } from "./dom.js";

const tokensStorageKey = "invokta-devtools.tokens";
const activeStorageKey = "invokta-devtools.active";

function readTokens(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(tokensStorageKey);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function readActiveKey(): string | null {
  try {
    return sessionStorage.getItem(activeStorageKey);
  } catch {
    return null;
  }
}

function writeTokens(tokens: Record<string, string>): void {
  try {
    sessionStorage.setItem(tokensStorageKey, JSON.stringify(tokens));
  } catch {
    // Session storage is a convenience; invocation still works in-memory.
  }
}

const tokens = readTokens();
let activeKey: string | null = readActiveKey();
const changeListeners = new Set<() => void>();

function storeToken(key: string, token: string): void {
  tokens[key] = token;
  writeTokens(tokens);
}

function forgetToken(key: string): void {
  delete tokens[key];
  writeTokens(tokens);
}

export function setActivePrincipal(key: string | null): void {
  activeKey = key;
  try {
    if (key === null) sessionStorage.removeItem(activeStorageKey);
    else sessionStorage.setItem(activeStorageKey, key);
  } catch {
    // Session storage is a convenience only.
  }
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // One interface listener cannot prevent the remaining updates.
    }
  }
}

export function getActivePrincipalKey(): string | null {
  return activeKey;
}

export function getActiveToken(): string | null {
  if (activeKey === null) return null;
  return tokens[activeKey] ?? null;
}

export function onPrincipalChange(listener: () => void): void {
  changeListeners.add(listener);
}

/**
 * Makes sure the interface holds a usable token: if no stored principal
 * token exists, the first listed principal's token is minted by rotation —
 * an explicit issuance, so the credential is returned exactly once.
 */
export async function ensureActiveToken(): Promise<void> {
  const principals = await api.principals();
  const knownKeys = new Set(principals.map(({ key }) => key));
  let tokensChanged = false;
  for (const key of Object.keys(tokens)) {
    if (knownKeys.has(key)) continue;
    delete tokens[key];
    tokensChanged = true;
  }
  if (tokensChanged) writeTokens(tokens);

  const selected =
    principals.find(({ key }) => key === activeKey) ?? principals[0];
  if (selected === undefined) {
    setActivePrincipal(null);
    return;
  }
  if (tokens[selected.key] !== undefined) {
    setActivePrincipal(selected.key);
    return;
  }

  const issued = await api.rotatePrincipal(selected.key);
  storeToken(issued.key, issued.token);
  setActivePrincipal(issued.key);
}

export function renderPrincipalsPanel(container: HTMLElement): () => void {
  let active = true;

  const render = async (): Promise<void> => {
    let principals: readonly PrincipalInfo[];
    try {
      principals = await api.principals();
    } catch {
      if (!active) return;
      clear(container);
      container.append(
        el("h2", {}, ["Development principals"]),
        el("p", { class: "feedback", role: "alert" }, [
          "Principals could not be loaded. Check that the dev server is still running.",
        ]),
      );
      return;
    }
    if (!active) return;
    clear(container);

    const rows = principals.map((entry: PrincipalInfo) => {
      const hasToken = tokens[entry.key] !== undefined;
      const isActive = entry.key === activeKey;
      const mint = el("button", { type: "button" }, [
        hasToken ? "Mint new token" : "Mint token",
      ]);
      mint.addEventListener("click", () => {
        mint.disabled = true;
        void api
          .rotatePrincipal(entry.key)
          .then((issued) => {
            if (!active) return;
            storeToken(issued.key, issued.token);
            setActivePrincipal(issued.key);
            void render();
          })
          .catch(() => {
            if (!active) return;
            mint.disabled = false;
            mint.textContent = "Try again";
          });
      });
      const activate = el("button", { type: "button" }, [
        hasToken ? "Use" : "Mint and use",
      ]);
      activate.addEventListener("click", () => {
        if (hasToken) {
          setActivePrincipal(entry.key);
          void render();
          return;
        }
        activate.disabled = true;
        void api
          .rotatePrincipal(entry.key)
          .then((issued) => {
            if (!active) return;
            storeToken(issued.key, issued.token);
            setActivePrincipal(issued.key);
            void render();
          })
          .catch(() => {
            if (!active) return;
            activate.disabled = false;
            activate.textContent = "Try again";
          });
      });
      const remove = el("button", { type: "button" }, ["Delete"]);
      remove.addEventListener("click", () => {
        remove.disabled = true;
        void api
          .removePrincipal(entry.key)
          .then(() => {
            if (!active) return;
            forgetToken(entry.key);
            if (activeKey === entry.key) setActivePrincipal(null);
            void render();
          })
          .catch(() => {
            if (!active) return;
            remove.disabled = false;
            remove.textContent = "Try again";
          });
      });
      return el("div", { class: `principal-row${isActive ? " active" : ""}` }, [
        el("div", { class: "principal-summary" }, [
          el("strong", {}, [entry.principal.id]),
          el("code", {}, [entry.key]),
          isActive ? el("span", { class: "badge ok" }, ["active"]) : null,
          hasToken ? null : el("span", { class: "badge warn" }, ["no token"]),
        ]),
        entry.principal.attributes === undefined
          ? null
          : el("pre", { class: "attributes" }, [
              pretty(entry.principal.attributes),
            ]),
        el("div", { class: "principal-actions" }, [activate, mint, remove]),
      ]);
    });

    const idInputId = "new-principal-id";
    const attributesInputId = "new-principal-attributes";
    const idInput = el("input", {
      id: idInputId,
      type: "text",
      placeholder: "principal id",
      autocomplete: "off",
    });
    const attributesInput = el("textarea", {
      id: attributesInputId,
      rows: "3",
      placeholder: '{"role":"reviewer"} (optional attributes JSON)',
    });
    const feedback = el("p", { class: "feedback", role: "alert" }, []);
    const create = el("button", { type: "button" }, ["Create principal"]);
    create.addEventListener("click", () => {
      feedback.textContent = "";
      const id = idInput.value.trim();
      if (id === "") {
        feedback.textContent = "A principal id is required.";
        return;
      }
      let attributes: Readonly<Record<string, unknown>> | undefined;
      const attributesText = attributesInput.value.trim();
      if (attributesText !== "") {
        try {
          const parsed = JSON.parse(attributesText) as unknown;
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            feedback.textContent = "The attributes must be a JSON object.";
            return;
          }
          attributes = parsed as Readonly<Record<string, unknown>>;
        } catch {
          feedback.textContent = "The attributes must be a JSON object.";
          return;
        }
      }
      create.disabled = true;
      create.textContent = "Creating…";
      void api
        .createPrincipal({
          id,
          ...(attributes === undefined ? {} : { attributes }),
        })
        .then((issued) => {
          if (!active) return;
          storeToken(issued.key, issued.token);
          setActivePrincipal(issued.key);
          void render();
        })
        .catch(() => {
          if (!active) return;
          create.disabled = false;
          create.textContent = "Create principal";
          feedback.textContent = "The principal could not be created.";
        });
    });

    container.append(
      el("h2", {}, ["Development principals"]),
      el("p", { class: "hint" }, [
        "Invocations authenticate with the active principal's bearer token. ",
        "Tokens live in this browser session only; mint a new one at any time.",
      ]),
      ...rows,
      el("div", { class: "principal-create" }, [
        el("h3", {}, ["New principal"]),
        el("label", { for: idInputId }, ["Principal ID"]),
        idInput,
        el("label", { for: attributesInputId }, ["Attributes (optional)"]),
        attributesInput,
        create,
        feedback,
      ]),
    );
  };

  clear(container);
  container.append(
    el("h2", {}, ["Development principals"]),
    el("p", { class: "hint", role: "status" }, ["Loading principals…"]),
  );
  void render();
  return () => {
    active = false;
  };
}
