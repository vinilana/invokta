import { api, type PrincipalInfo } from "./api.js";
import { clear, el, pretty } from "./dom.js";

const tokensStorageKey = "invokta-devtools.tokens";
const activeStorageKey = "invokta-devtools.active";

function readTokens(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(tokensStorageKey);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
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
let activeKey: string | null = sessionStorage.getItem(activeStorageKey);
const changeListeners = new Set<() => void>();

function storeToken(key: string, token: string): void {
  tokens[key] = token;
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
  for (const listener of changeListeners) listener();
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
  if (getActiveToken() !== null) return;
  const principals = await api.principals();
  const first = principals[0];
  if (first === undefined) return;
  const issued = await api.rotatePrincipal(first.key);
  storeToken(issued.key, issued.token);
  setActivePrincipal(issued.key);
}

export function renderPrincipalsPanel(container: HTMLElement): void {
  const render = async (): Promise<void> => {
    const principals = await api.principals();
    clear(container);

    const rows = principals.map((entry: PrincipalInfo) => {
      const hasToken = tokens[entry.key] !== undefined;
      const isActive = entry.key === activeKey;
      const mint = el("button", { type: "button" }, [
        hasToken ? "Mint new token" : "Mint token",
      ]);
      mint.addEventListener("click", () => {
        void api.rotatePrincipal(entry.key).then((issued) => {
          storeToken(issued.key, issued.token);
          setActivePrincipal(issued.key);
          void render();
        });
      });
      const activate = el("button", { type: "button" }, ["Use"]);
      activate.addEventListener("click", () => {
        setActivePrincipal(entry.key);
        void render();
      });
      const remove = el("button", { type: "button" }, ["Delete"]);
      remove.addEventListener("click", () => {
        void api.removePrincipal(entry.key).then(() => {
          if (activeKey === entry.key) setActivePrincipal(null);
          void render();
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

    const idInput = el("input", {
      type: "text",
      placeholder: "principal id",
    });
    const attributesInput = el("textarea", {
      rows: "3",
      placeholder: '{"role":"reviewer"} (optional attributes JSON)',
    });
    const feedback = el("p", { class: "feedback" }, []);
    const create = el("button", { type: "button" }, ["Create principal"]);
    create.addEventListener("click", () => {
      const id = idInput.value.trim();
      if (id === "") {
        feedback.textContent = "A principal id is required.";
        return;
      }
      let attributes: Readonly<Record<string, unknown>> | undefined;
      const attributesText = attributesInput.value.trim();
      if (attributesText !== "") {
        try {
          attributes = JSON.parse(attributesText) as Readonly<
            Record<string, unknown>
          >;
        } catch {
          feedback.textContent = "The attributes must be a JSON object.";
          return;
        }
      }
      void api
        .createPrincipal({
          id,
          ...(attributes === undefined ? {} : { attributes }),
        })
        .then((issued) => {
          storeToken(issued.key, issued.token);
          setActivePrincipal(issued.key);
          void render();
        })
        .catch(() => {
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
        idInput,
        attributesInput,
        create,
        feedback,
      ]),
    );
  };

  void render();
}
