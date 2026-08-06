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
  const tokenGuidanceId = "principal-token-guidance";

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

    const rows = principals.map((entry: PrincipalInfo, index) => {
      const hasToken = tokens[entry.key] !== undefined;
      const isActive = entry.key === activeKey;
      const statusId = `principal-action-status-${String(index)}`;
      const actionStatus = el(
        "p",
        {
          id: statusId,
          class: "principal-status",
          role: "status",
          "aria-live": "polite",
          "aria-atomic": "true",
        },
        [],
      );
      const actionButtons: HTMLButtonElement[] = [];
      const setActionStatus = (
        message: string,
        kind: "neutral" | "error" = "neutral",
      ): void => {
        actionStatus.setAttribute(
          "class",
          kind === "error"
            ? "principal-status feedback"
            : "principal-status hint",
        );
        actionStatus.setAttribute(
          "role",
          kind === "error" ? "alert" : "status",
        );
        actionStatus.textContent = message;
      };
      const setActionsDisabled = (disabled: boolean): void => {
        for (const button of actionButtons) button.disabled = disabled;
      };

      if (hasToken && !isActive) {
        const activate = el(
          "button",
          {
            type: "button",
            "aria-label": `Use ${entry.principal.id} for invocations`,
          },
          ["Use"],
        );
        activate.addEventListener("click", () => {
          setActivePrincipal(entry.key);
          void render();
        });
        actionButtons.push(activate);
      }

      const tokenActionLabel = hasToken ? "Replace token" : "Mint & use";
      const tokenAction = el(
        "button",
        {
          type: "button",
          class: hasToken ? "credential-action" : "",
          "aria-label": `${hasToken ? "Replace token" : "Mint token and use"} for ${entry.principal.id}`,
          "aria-describedby": hasToken
            ? `${tokenGuidanceId} ${statusId}`
            : statusId,
        },
        [tokenActionLabel],
      );
      tokenAction.addEventListener("click", () => {
        setActionsDisabled(true);
        tokenAction.textContent = hasToken ? "Replacing…" : "Minting…";
        setActionStatus(
          hasToken
            ? "Replacing the token and selecting this principal…"
            : "Minting a token and selecting this principal…",
        );
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
            setActionsDisabled(false);
            tokenAction.textContent = tokenActionLabel;
            setActionStatus(
              hasToken
                ? "The token could not be replaced. The existing token is still valid."
                : "A token could not be minted. Try again.",
              "error",
            );
          });
      });
      actionButtons.push(tokenAction);

      let confirmingDelete = false;
      const remove = el(
        "button",
        {
          type: "button",
          class: "danger",
          "aria-label": `Delete principal ${entry.principal.id}`,
          "aria-controls": statusId,
          "aria-expanded": "false",
        },
        ["Delete…"],
      );
      const cancelDelete = el(
        "button",
        { type: "button", "aria-label": "Cancel principal deletion" },
        ["Cancel"],
      );
      cancelDelete.hidden = true;
      const resetDelete = (): void => {
        confirmingDelete = false;
        remove.textContent = "Delete…";
        remove.setAttribute(
          "aria-label",
          `Delete principal ${entry.principal.id}`,
        );
        remove.setAttribute("aria-expanded", "false");
        cancelDelete.hidden = true;
      };
      remove.addEventListener("click", () => {
        if (!confirmingDelete) {
          confirmingDelete = true;
          remove.textContent = "Confirm delete";
          remove.setAttribute(
            "aria-label",
            `Confirm deletion of principal ${entry.principal.id}`,
          );
          remove.setAttribute("aria-expanded", "true");
          cancelDelete.hidden = false;
          setActionStatus(
            `Delete “${entry.principal.id}”? Its token will stop working immediately.`,
          );
          return;
        }

        setActionsDisabled(true);
        remove.textContent = "Deleting…";
        setActionStatus(`Deleting principal “${entry.principal.id}”…`);
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
            setActionsDisabled(false);
            resetDelete();
            setActionStatus(
              `Principal “${entry.principal.id}” could not be deleted. Try again.`,
              "error",
            );
          });
      });
      cancelDelete.addEventListener("click", () => {
        resetDelete();
        setActionStatus("");
      });
      actionButtons.push(remove, cancelDelete);

      return el(
        "div",
        {
          class: `principal-row${isActive ? " active" : ""}`,
          role: "group",
          "aria-label": `Principal ${entry.principal.id}`,
        },
        [
          el("div", { class: "principal-summary" }, [
            el("strong", {}, [entry.principal.id]),
            el("span", { class: "hint" }, [
              "Key ",
              el("code", {}, [entry.key]),
            ]),
            el("span", { class: `badge${isActive ? " ok" : ""}` }, [
              isActive ? "Active" : "Inactive",
            ]),
            el("span", { class: `badge ${hasToken ? "ok" : "warn"}` }, [
              hasToken ? "Token ready" : "No token",
            ]),
          ]),
          entry.principal.attributes === undefined
            ? null
            : el("details", { class: "principal-attributes" }, [
                el("summary", {}, ["Attributes"]),
                el("pre", { class: "attributes" }, [
                  pretty(entry.principal.attributes),
                ]),
              ]),
          el("div", { class: "principal-actions" }, actionButtons),
          actionStatus,
        ],
      );
    });

    const idInputId = "new-principal-id";
    const attributesInputId = "new-principal-attributes";
    const idInput = el("input", {
      id: idInputId,
      type: "text",
      placeholder: "local-dev",
      autocomplete: "off",
      spellcheck: "false",
    });
    const attributesInput = el("textarea", {
      id: attributesInputId,
      rows: "3",
      placeholder: '{"role":"reviewer"}',
      spellcheck: "false",
    });
    const feedback = el(
      "p",
      {
        class: "principal-status",
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
      },
      [],
    );
    const setCreateFeedback = (
      message: string,
      kind: "neutral" | "error" = "neutral",
    ): void => {
      feedback.setAttribute(
        "class",
        kind === "error"
          ? "principal-status feedback"
          : "principal-status hint",
      );
      feedback.setAttribute("role", kind === "error" ? "alert" : "status");
      feedback.textContent = message;
    };
    const create = el("button", { type: "button" }, ["Create principal"]);
    create.addEventListener("click", () => {
      setCreateFeedback("");
      const id = idInput.value.trim();
      if (id === "") {
        setCreateFeedback("A principal ID is required.", "error");
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
            setCreateFeedback("Attributes must be a JSON object.", "error");
            return;
          }
          attributes = parsed as Readonly<Record<string, unknown>>;
        } catch {
          setCreateFeedback("Attributes must be a JSON object.", "error");
          return;
        }
      }
      create.disabled = true;
      create.textContent = "Creating…";
      setCreateFeedback(
        `Creating “${id}”, minting its token, and making it active…`,
      );
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
          setCreateFeedback(
            "The principal could not be created. Try again.",
            "error",
          );
        });
    });

    container.append(
      el("h2", {}, ["Development principals"]),
      el("p", { id: tokenGuidanceId, class: "hint" }, [
        "The active principal authenticates invocations. The development server ",
        "keeps principals and tokens in memory; minted bearer tokens are also ",
        "kept in this browser session. Token values are not displayed here. ",
        "Replacing a token revokes the previous token immediately.",
      ]),
      ...(principals.length === 0
        ? [
            el("p", { class: "empty" }, [
              "No development principals. Add one to authenticate invocations.",
            ]),
          ]
        : []),
      ...rows,
      el("details", { class: "principal-create" }, [
        el("summary", {}, ["Add principal"]),
        el("p", { class: "hint" }, [
          "Creating a principal also mints its token and makes it active.",
        ]),
        el("label", { for: idInputId }, ["Principal ID"]),
        idInput,
        el("label", { for: attributesInputId }, ["Attributes JSON (optional)"]),
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
