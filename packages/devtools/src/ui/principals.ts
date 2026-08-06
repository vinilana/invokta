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
let knownPrincipals = new Map<string, PrincipalInfo>();
const changeListeners = new Set<() => void>();

export interface ActivePrincipalStatus {
  readonly key: string;
  readonly principalId: string;
  readonly hasSessionToken: boolean;
}

function rememberPrincipals(principals: readonly PrincipalInfo[]): void {
  knownPrincipals = new Map(principals.map((entry) => [entry.key, entry]));
}

function rememberPrincipal(principal: PrincipalInfo): void {
  knownPrincipals.set(principal.key, principal);
}

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

export function getActivePrincipalStatus(): ActivePrincipalStatus | null {
  if (activeKey === null) return null;
  const activePrincipal = knownPrincipals.get(activeKey);
  if (activePrincipal === undefined) return null;
  return {
    key: activePrincipal.key,
    principalId: activePrincipal.principal.id,
    hasSessionToken: tokens[activePrincipal.key] !== undefined,
  };
}

export function onPrincipalChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * Reconciles browser-session state with the listed principals and selects a
 * valid principal. Initialization never issues, rotates, or revokes a token.
 */
export async function ensureActiveToken(): Promise<void> {
  const principals = await api.principals();
  rememberPrincipals(principals);
  const knownKeys = new Set(principals.map(({ key }) => key));
  let tokensChanged = false;
  for (const key of Object.keys(tokens)) {
    if (knownKeys.has(key)) continue;
    delete tokens[key];
    tokensChanged = true;
  }
  if (tokensChanged) writeTokens(tokens);

  const selected =
    principals.find(({ key }) => key === activeKey) ??
    principals.find(({ key }) => tokens[key] !== undefined) ??
    principals[0];
  if (selected === undefined) {
    setActivePrincipal(null);
    return;
  }
  setActivePrincipal(selected.key);
}

export function renderPrincipalsPanel(container: HTMLElement): () => void {
  type FocusTarget =
    | { readonly kind: "principal"; readonly key: string }
    | { readonly kind: "token-action"; readonly key: string }
    | { readonly kind: "create-action" }
    | { readonly kind: "after-delete"; readonly index: number };
  interface PendingCompletion {
    readonly message: string;
    readonly focus: FocusTarget;
  }

  let active = true;
  let pendingCompletion: PendingCompletion | null = null;
  const tokenGuidanceId = "principal-token-guidance";
  const panelBody = el("div", { class: "principals-panel-body" }, []);
  const panelStatus = el(
    "p",
    {
      id: "principals-panel-status",
      class: "principal-status hint",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    [],
  );
  const clearPanelStatus = (): void => {
    panelStatus.textContent = "";
  };

  const render = async (): Promise<void> => {
    let principals: readonly PrincipalInfo[];
    try {
      principals = await api.principals();
    } catch {
      if (!active) return;
      clear(panelBody);
      const heading = el("h2", { tabindex: "-1" }, ["Test identities"]);
      panelBody.append(
        heading,
        el("p", { class: "feedback", role: "alert" }, [
          "Couldn’t load test identities. Check that the dev server is running.",
        ]),
      );
      if (pendingCompletion !== null) {
        panelStatus.textContent = pendingCompletion.message;
        pendingCompletion = null;
        heading.focus();
      }
      return;
    }
    if (!active) return;
    rememberPrincipals(principals);
    clear(panelBody);

    const rowViews: Array<{
      readonly key: string;
      readonly row: HTMLDivElement;
      readonly tokenAction: HTMLButtonElement;
    }> = [];
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

      if (!isActive) {
        const activate = el(
          "button",
          {
            type: "button",
            "aria-label": `Act as ${entry.principal.id} for invocations`,
          },
          ["Act as"],
        );
        activate.addEventListener("click", () => {
          clearPanelStatus();
          pendingCompletion = {
            message: hasToken
              ? `“${entry.principal.id}” is now active.`
              : `“${entry.principal.id}” is now active. No session token is available.`,
            focus: { kind: "principal", key: entry.key },
          };
          setActivePrincipal(entry.key);
          void render();
        });
        actionButtons.push(activate);
      }

      const tokenActionLabel = "Rotate token and use…";
      const tokenAction = el(
        "button",
        {
          type: "button",
          class: "credential-action",
          "aria-label": `Rotate token and use for ${entry.principal.id}`,
          "aria-describedby": `${tokenGuidanceId} ${statusId}`,
        },
        [tokenActionLabel],
      );
      const remove = el(
        "button",
        {
          type: "button",
          class: "danger",
          "aria-label": `Delete test identity ${entry.principal.id}`,
          "aria-describedby": statusId,
        },
        ["Delete…"],
      );
      const cancelConfirmation = el(
        "button",
        {
          type: "button",
          "aria-label": `Cancel pending action for test identity ${entry.principal.id}`,
        },
        ["Cancel"],
      );
      cancelConfirmation.hidden = true;
      let confirmation: "rotation" | "deletion" | null = null;
      const resetConfirmation = (): void => {
        confirmation = null;
        tokenAction.textContent = tokenActionLabel;
        tokenAction.setAttribute(
          "aria-label",
          `Rotate token and use for ${entry.principal.id}`,
        );
        remove.textContent = "Delete…";
        remove.setAttribute(
          "aria-label",
          `Delete test identity ${entry.principal.id}`,
        );
        cancelConfirmation.hidden = true;
      };
      const beginConfirmation = (kind: "rotation" | "deletion"): void => {
        clearPanelStatus();
        resetConfirmation();
        confirmation = kind;
        cancelConfirmation.hidden = false;
        if (kind === "rotation") {
          tokenAction.textContent = "Confirm rotation";
          tokenAction.setAttribute(
            "aria-label",
            `Confirm token rotation for ${entry.principal.id}`,
          );
          setActionStatus(
            `Rotate the token for “${entry.principal.id}”? The current token will stop working immediately.`,
          );
          return;
        }
        remove.textContent = "Confirm delete";
        remove.setAttribute(
          "aria-label",
          `Confirm deletion of test identity ${entry.principal.id}`,
        );
        setActionStatus(
          `Delete “${entry.principal.id}”? Its token will stop working immediately.`,
        );
      };
      const rotateToken = (): void => {
        clearPanelStatus();
        resetConfirmation();
        setActionsDisabled(true);
        tokenAction.textContent = "Rotating…";
        setActionStatus(
          "Rotating the token and making this test identity active…",
        );
        void api
          .rotatePrincipal(entry.key)
          .then((issued) => {
            if (!active) return;
            rememberPrincipal(issued);
            storeToken(issued.key, issued.token);
            pendingCompletion = {
              message: `Rotated the session token for “${entry.principal.id}” and made it active. The previous token was revoked.`,
              focus: { kind: "token-action", key: issued.key },
            };
            setActivePrincipal(issued.key);
            void render();
          })
          .catch(() => {
            if (!active) return;
            setActionsDisabled(false);
            resetConfirmation();
            setActionStatus(
              "The token could not be rotated. Any existing token remains valid.",
              "error",
            );
          });
      };
      tokenAction.addEventListener("click", () => {
        if (confirmation !== "rotation") {
          beginConfirmation("rotation");
          return;
        }
        rotateToken();
      });
      remove.addEventListener("click", () => {
        if (confirmation !== "deletion") {
          beginConfirmation("deletion");
          return;
        }

        resetConfirmation();
        setActionsDisabled(true);
        remove.textContent = "Deleting…";
        setActionStatus(`Deleting test identity “${entry.principal.id}”…`);
        void api
          .removePrincipal(entry.key)
          .then(() => {
            if (!active) return;
            forgetToken(entry.key);
            knownPrincipals.delete(entry.key);
            pendingCompletion = {
              message: `Deleted “${entry.principal.id}” and revoked its token.`,
              focus: { kind: "after-delete", index },
            };
            if (activeKey === entry.key) setActivePrincipal(null);
            void render();
          })
          .catch(() => {
            if (!active) return;
            setActionsDisabled(false);
            resetConfirmation();
            setActionStatus(
              `Test identity “${entry.principal.id}” could not be deleted. Try again.`,
              "error",
            );
          });
      });
      cancelConfirmation.addEventListener("click", () => {
        resetConfirmation();
        setActionStatus("");
      });
      actionButtons.push(tokenAction, remove, cancelConfirmation);

      const row = el(
        "div",
        {
          class: `principal-row${isActive ? " active" : ""}`,
          role: "group",
          "aria-label": `Test identity ${entry.principal.id}`,
          tabindex: "-1",
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
              hasToken ? "Token in session" : "No session token",
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
      rowViews.push({ key: entry.key, row, tokenAction });
      return row;
    });

    const idInputId = "new-principal-id";
    const attributesInputId = "new-principal-attributes";
    const createHintId = "new-principal-hint";
    const createFeedbackId = "new-principal-feedback";
    const idInput = el("input", {
      id: idInputId,
      type: "text",
      placeholder: "local-dev",
      autocomplete: "off",
      spellcheck: "false",
      "aria-describedby": createHintId,
      "aria-errormessage": createFeedbackId,
      "aria-invalid": "false",
    });
    const attributesInput = el("textarea", {
      id: attributesInputId,
      rows: "3",
      placeholder: '{"role":"reviewer"}',
      spellcheck: "false",
      "aria-describedby": createHintId,
      "aria-errormessage": createFeedbackId,
      "aria-invalid": "false",
    });
    const feedback = el(
      "p",
      {
        id: createFeedbackId,
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
    const resetCreateValidation = (): void => {
      idInput.setAttribute("aria-invalid", "false");
      attributesInput.setAttribute("aria-invalid", "false");
      setCreateFeedback("");
    };
    const clearFieldError = (
      field: HTMLInputElement | HTMLTextAreaElement,
    ): void => {
      field.setAttribute("aria-invalid", "false");
      if (
        idInput.getAttribute("aria-invalid") === "false" &&
        attributesInput.getAttribute("aria-invalid") === "false"
      ) {
        setCreateFeedback("");
      }
    };
    idInput.addEventListener("input", () => {
      clearFieldError(idInput);
    });
    attributesInput.addEventListener("input", () => {
      clearFieldError(attributesInput);
    });
    const create = el("button", { type: "button" }, ["Add identity"]);
    create.addEventListener("click", () => {
      clearPanelStatus();
      resetCreateValidation();
      const id = idInput.value.trim();
      if (id === "") {
        idInput.setAttribute("aria-invalid", "true");
        setCreateFeedback("Enter a Principal ID.", "error");
        idInput.focus();
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
            attributesInput.setAttribute("aria-invalid", "true");
            setCreateFeedback("Attributes must be a JSON object.", "error");
            attributesInput.focus();
            return;
          }
          attributes = parsed as Readonly<Record<string, unknown>>;
        } catch {
          attributesInput.setAttribute("aria-invalid", "true");
          setCreateFeedback("Attributes must be a JSON object.", "error");
          attributesInput.focus();
          return;
        }
      }
      create.disabled = true;
      create.textContent = "Adding…";
      setCreateFeedback(
        `Adding “${id}”, minting its token, and making it active…`,
      );
      void api
        .createPrincipal({
          id,
          ...(attributes === undefined ? {} : { attributes }),
        })
        .then((issued) => {
          if (!active) return;
          rememberPrincipal(issued);
          storeToken(issued.key, issued.token);
          pendingCompletion = {
            message: `Added “${issued.principal.id}”, minted its session token, and made it active.`,
            focus: { kind: "create-action" },
          };
          setActivePrincipal(issued.key);
          void render();
        })
        .catch(() => {
          if (!active) return;
          create.disabled = false;
          create.textContent = "Add identity";
          setCreateFeedback(
            "The test identity could not be added. Try again.",
            "error",
          );
        });
    });

    const heading = el("h2", { tabindex: "-1" }, ["Test identities"]);
    const createSection = el("details", { class: "principal-create" }, [
      el("summary", {}, ["Add identity"]),
      el("p", { id: createHintId, class: "hint" }, [
        "Adding a test identity also mints its token and makes it active.",
      ]),
      el("label", { for: idInputId }, ["Principal ID"]),
      idInput,
      el("label", { for: attributesInputId }, ["Attributes (JSON, optional)"]),
      attributesInput,
      create,
      feedback,
    ]);
    panelBody.append(
      heading,
      el("p", { id: tokenGuidanceId, class: "hint" }, [
        "The selected test identity authenticates invocations as an Invokta Principal. ",
        "The development server keeps test identities and tokens in memory; minted bearer tokens are also ",
        "kept in this browser session. Token values are not displayed here. ",
        "Rotating a token revokes the previous token immediately.",
      ]),
      ...(principals.length === 0
        ? [
            el("p", { class: "empty" }, [
              "No test identities yet. Add one to authenticate invocations.",
            ]),
          ]
        : []),
      ...rows,
      createSection,
    );

    const completion = pendingCompletion;
    if (completion !== null) {
      pendingCompletion = null;
      let focusTarget: HTMLElement;
      if (completion.focus.kind === "principal") {
        const key = completion.focus.key;
        focusTarget = rowViews.find((view) => view.key === key)?.row ?? heading;
      } else if (completion.focus.kind === "token-action") {
        const key = completion.focus.key;
        const principalView = rowViews.find((view) => view.key === key);
        focusTarget =
          principalView?.tokenAction ?? principalView?.row ?? heading;
      } else if (completion.focus.kind === "create-action") {
        createSection.setAttribute("open", "");
        focusTarget = create;
      } else {
        focusTarget =
          rowViews.at(Math.min(completion.focus.index, rowViews.length - 1))
            ?.row ?? heading;
      }
      focusTarget.focus();
      panelStatus.textContent = completion.message;
    }
  };

  clear(container);
  container.append(panelBody, panelStatus);
  panelBody.append(
    el("h2", {}, ["Test identities"]),
    el("p", { class: "hint", role: "status" }, ["Loading test identities…"]),
  );
  void render();
  return () => {
    active = false;
  };
}
