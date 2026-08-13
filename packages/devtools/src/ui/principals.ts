import { api, type PrincipalInfo } from "./api.js";
import { clear, el, pretty } from "./dom.js";

const tokensStorageKey = "invokta-devtools.tokens";
const activeStorageKey = "invokta-devtools.active";

/**
 * Quick-fill identities for the create form; none of them mints anything. The
 * attributes are the ones an `access` rule actually reads, so a filled form
 * passes or fails a real rule instead of teaching a shape nothing checks.
 */
const attributePresets: ReadonlyArray<{
  readonly label: string;
  readonly id: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}> = [
  {
    label: "Ticket analyst",
    id: "local:operations-analyst",
    attributes: {
      permissions: [
        "ticket:read",
        "ticket:classify",
        "ticket:draft-reply",
        "knowledge:search",
      ],
      allowedTicketIds: ["T-123", "T-456", "T-789"],
    },
  },
  {
    label: "Ticket reader",
    id: "local:reader",
    attributes: { permissions: ["ticket:read"] },
  },
  {
    label: "No permissions",
    id: "local:no-permissions",
    attributes: { permissions: [] },
  },
];

/** One emulated call as the trace stream reports it, for the Recent lines. */
interface RecentCall {
  readonly adapter: string;
  readonly capabilityId: string;
  readonly outcome: string;
  /** The identity the call acted as; `null` when it ran anonymously. */
  readonly principalId?: string | null;
}

const outcomeLabels: Readonly<Record<string, string>> = {
  success: "Success",
  "capability-error": "Capability error",
  "adapter-error": "Adapter error",
};

/** Emulated calls the panel remembers, across every identity. */
const recentCallCapacity = 24;
/** How many of them one identity shows. */
const recentCallsPerIdentity = 3;

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

/**
 * Acting anonymously is a deliberate choice, not a missing selection: it is
 * how an `access` rule gets denied on purpose. It is stored under a reserved
 * value, because a real principal key is always minted as `p_…`.
 */
const anonymousSelection = "anonymous";

const tokens = readTokens();
const storedSelection = readActiveKey();
let activeKey: string | null =
  storedSelection === anonymousSelection ? null : storedSelection;
let selectionIsExplicit = storedSelection !== null;
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

function notifyPrincipalChange(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // One interface listener cannot prevent the remaining updates.
    }
  }
}

export function setActivePrincipal(key: string | null): void {
  activeKey = key;
  selectionIsExplicit = true;
  try {
    sessionStorage.setItem(activeStorageKey, key ?? anonymousSelection);
  } catch {
    // Session storage is a convenience only.
  }
  notifyPrincipalChange();
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
/** The principals the interface has seen, for the invocation identity picker. */
export function listKnownPrincipals(): readonly PrincipalInfo[] {
  return [...knownPrincipals.values()];
}

export async function ensureActiveToken(): Promise<void> {
  const principals = await api.principals();
  rememberPrincipals(principals);
  if (selectionIsExplicit && activeKey === null) {
    // The developer chose to act anonymously; do not undo it on reload.
    notifyPrincipalChange();
    return;
  }
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
  /** Newest first, bounded, and dropped when the panel closes. */
  const recentCalls: RecentCall[] = [];
  let recentViews: ReadonlyArray<{
    readonly principalId: string;
    readonly element: HTMLElement;
  }> = [];
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

  /** What one identity managed to do, newest first. */
  const recentContent = (principalId: string): HTMLElement[] => {
    const calls = recentCalls
      .filter((call) => call.principalId === principalId)
      .slice(0, recentCallsPerIdentity);
    if (calls.length === 0) {
      return [el("span", { class: "hint" }, ["No emulated calls yet."])];
    }
    return calls.map((call) =>
      el("span", { class: "principal-recent-call" }, [
        el("code", {}, [call.capabilityId]),
        ` · ${call.adapter} · ${outcomeLabels[call.outcome] ?? call.outcome}`,
      ]),
    );
  };

  const paintRecent = (): void => {
    for (const view of recentViews) {
      clear(view.element);
      view.element.append(...recentContent(view.principalId));
    }
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

    let editingKey: string | null = null;
    const rowViews: Array<{
      readonly key: string;
      readonly row: HTMLDivElement;
      readonly tokenAction: HTMLButtonElement;
    }> = [];
    const nextRecentViews: Array<{
      readonly principalId: string;
      readonly element: HTMLElement;
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
            message: `“${entry.principal.id}” is now active.`,
            focus: { kind: "principal", key: entry.key },
          };
          setActivePrincipal(entry.key);
          void render();
        });
        actionButtons.push(activate);
      }

      const tokenActionLabel = hasToken
        ? "Rotate token and use…"
        : "Create session token and use…";
      const tokenActionAriaLabel = hasToken
        ? `Rotate token and use for ${entry.principal.id}`
        : `Create session token and use for ${entry.principal.id}`;
      const tokenAction = el(
        "button",
        {
          type: "button",
          class: "credential-action",
          "aria-label": tokenActionAriaLabel,
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
        tokenAction.setAttribute("aria-label", tokenActionAriaLabel);
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
          if (hasToken) {
            tokenAction.textContent = "Confirm rotation";
            tokenAction.setAttribute(
              "aria-label",
              `Confirm token rotation for ${entry.principal.id}`,
            );
            setActionStatus(
              `Rotate the token for “${entry.principal.id}”? The current token will stop working immediately.`,
            );
          } else {
            tokenAction.textContent = "Confirm token creation";
            tokenAction.setAttribute(
              "aria-label",
              `Confirm session token creation for ${entry.principal.id}`,
            );
            setActionStatus(
              `Create a session token for “${entry.principal.id}” and use it for invocations?`,
            );
          }
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
      const issueToken = (): void => {
        clearPanelStatus();
        resetConfirmation();
        setActionsDisabled(true);
        tokenAction.textContent = hasToken ? "Rotating…" : "Creating…";
        setActionStatus(
          hasToken
            ? "Rotating the token and selecting this test identity…"
            : "Creating a token and selecting this test identity…",
        );
        void api
          .rotatePrincipal(entry.key)
          .then((issued) => {
            if (!active) return;
            rememberPrincipal(issued);
            storeToken(issued.key, issued.token);
            pendingCompletion = {
              message: hasToken
                ? `Rotated the session token for “${entry.principal.id}” and made it active. The previous token was revoked.`
                : `Created a session token for “${entry.principal.id}” and selected it for invocations.`,
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
              hasToken
                ? "The token could not be rotated. The existing token remains valid."
                : "The session token could not be created. No credential was added.",
              "error",
            );
          });
      };
      tokenAction.addEventListener("click", () => {
        if (confirmation !== "rotation") {
          beginConfirmation("rotation");
          return;
        }
        issueToken();
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
      const fillForm = (id: string): void => {
        clearPanelStatus();
        resetCreateValidation();
        createSection.setAttribute("open", "");
        idInput.value = id;
        attributesInput.value =
          entry.principal.attributes === undefined
            ? ""
            : pretty(entry.principal.attributes);
      };
      const edit = el(
        "button",
        {
          type: "button",
          "aria-label": `Edit test identity ${entry.principal.id}`,
        },
        ["Edit"],
      );
      edit.addEventListener("click", () => {
        fillForm(entry.principal.id);
        beginEditing(entry);
        idInput.focus();
      });
      const duplicate = el(
        "button",
        {
          type: "button",
          "aria-label": `Duplicate test identity ${entry.principal.id}`,
        },
        ["Duplicate"],
      );
      duplicate.addEventListener("click", () => {
        fillForm(`${entry.principal.id}-copy`);
        beginEditing(null);
        idInput.focus();
      });
      cancelConfirmation.addEventListener("click", () => {
        resetConfirmation();
        setActionStatus("");
      });
      actionButtons.push(
        tokenAction,
        edit,
        duplicate,
        remove,
        cancelConfirmation,
      );

      const recentCallList = el("div", { class: "principal-recent-calls" }, [
        ...recentContent(entry.principal.id),
      ]);
      nextRecentViews.push({
        principalId: entry.principal.id,
        element: recentCallList,
      });
      const recent = el("div", { class: "principal-recent" }, [
        el("span", { class: "principal-state-label" }, ["Recent"]),
        recentCallList,
      ]);

      const row = el(
        "div",
        {
          class: `principal-row${isActive ? " active" : ""}`,
          role: "group",
          "aria-label": `Test identity ${entry.principal.id}`,
          "aria-describedby": `principal-invocation-state-${String(index)} principal-credential-state-${String(index)}`,
          tabindex: "-1",
        },
        [
          el("div", { class: "principal-row-main" }, [
            el("div", { class: "principal-identity" }, [
              el("span", { class: "principal-overline" }, ["Test identity"]),
              el("strong", { class: "principal-name" }, [entry.principal.id]),
              el("span", { class: "hint principal-key" }, [
                "Internal key ",
                el("code", {}, [entry.key]),
              ]),
            ]),
            el("div", { class: "principal-state-grid" }, [
              el("div", { class: "principal-invocation-state" }, [
                el("span", { class: "principal-state-label" }, ["Invocation"]),
                el(
                  "span",
                  {
                    id: `principal-invocation-state-${String(index)}`,
                    class: `badge${isActive ? " ok" : ""}`,
                  },
                  [isActive ? "Selected" : "Not selected"],
                ),
              ]),
              el(
                "div",
                {
                  id: `principal-credential-state-${String(index)}`,
                  class: "principal-credential-state",
                },
                [
                  el("span", { class: "principal-state-label" }, [
                    "MCP HTTP credential",
                  ]),
                  el("span", { class: `badge${hasToken ? " ok" : ""}` }, [
                    hasToken ? "Session token ready" : "No session token",
                  ]),
                  hasToken
                    ? null
                    : el("span", { class: "hint principal-credential-note" }, [
                        "Only MCP HTTP against the devtools host presents one.",
                      ]),
                ],
              ),
            ]),
          ]),
          recent,
          entry.principal.attributes === undefined
            ? null
            : el("details", { class: "principal-attributes" }, [
                el("summary", {}, ["Attributes"]),
                el("pre", { class: "attributes" }, [
                  pretty(entry.principal.attributes),
                ]),
              ]),
          el(
            "div",
            {
              class: "principal-actions",
              role: "group",
              "aria-label": `Actions for ${entry.principal.id}`,
            },
            actionButtons,
          ),
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
      placeholder: '{"permissions":["ticket:read"]}',
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
    const presetButtons = attributePresets.map((preset) => {
      const button = el(
        "button",
        {
          type: "button",
          class: "principal-preset",
          "aria-label": `Fill the form with the ${preset.label} preset`,
        },
        [preset.label],
      );
      button.addEventListener("click", () => {
        resetCreateValidation();
        idInput.value = preset.id;
        attributesInput.value =
          preset.attributes === undefined ? "" : pretty(preset.attributes);
        beginEditing(null);
        idInput.focus();
      });
      return button;
    });
    /** The form's one reading of its fields, shared by adding and editing. */
    const readFormPrincipal = (): {
      readonly id: string;
      readonly attributes?: Readonly<Record<string, unknown>>;
    } | null => {
      const id = idInput.value.trim();
      if (id === "") {
        idInput.setAttribute("aria-invalid", "true");
        setCreateFeedback("Enter a Principal ID.", "error");
        idInput.focus();
        return null;
      }
      const attributesText = attributesInput.value.trim();
      if (attributesText === "") return { id };
      let parsed: unknown;
      try {
        parsed = JSON.parse(attributesText);
      } catch {
        parsed = undefined;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        attributesInput.setAttribute("aria-invalid", "true");
        setCreateFeedback("Attributes must be a JSON object.", "error");
        attributesInput.focus();
        return null;
      }
      return { id, attributes: parsed as Readonly<Record<string, unknown>> };
    };

    const create = el("button", { type: "button" }, ["Add identity"]);
    const cancelEdit = el(
      "button",
      { type: "button", "aria-label": "Cancel editing this identity" },
      ["Cancel"],
    );
    cancelEdit.hidden = true;
    /**
     * Switches the one form between adding a new identity and editing an
     * existing one; editing keeps the identity's key and its token.
     */
    const beginEditing = (entry: PrincipalInfo | null): void => {
      editingKey = entry?.key ?? null;
      const editing = entry !== null;
      createHeading.textContent = editing ? "Edit identity" : "Add identity";
      createOutcome.textContent = editing
        ? "Keeps its key and session token"
        : "Mints a token and activates it";
      createHint.textContent = editing
        ? `Editing “${entry.principal.id}”. Its key and session token stay as they are.`
        : "Create an in-memory Principal for development and homologation. Its bearer token stays hidden in this browser session.";
      create.textContent = editing ? "Save changes" : "Add identity";
      cancelEdit.hidden = !editing;
    };
    cancelEdit.addEventListener("click", () => {
      resetCreateValidation();
      idInput.value = "";
      attributesInput.value = "";
      beginEditing(null);
      idInput.focus();
    });
    const saveEdit = (
      key: string,
      principal: {
        readonly id: string;
        readonly attributes?: Readonly<Record<string, unknown>>;
      },
    ): void => {
      create.disabled = true;
      create.textContent = "Saving…";
      setCreateFeedback(`Saving “${principal.id}”…`);
      void api
        .updatePrincipal(key, principal)
        .then((updated) => {
          if (!active) return;
          rememberPrincipal(updated);
          // The identity picker reads the same list, so it repaints too.
          notifyPrincipalChange();
          pendingCompletion = {
            message: `Updated “${updated.principal.id}”.`,
            focus: { kind: "principal", key: updated.key },
          };
          void render();
        })
        .catch((error: unknown) => {
          if (!active) return;
          create.disabled = false;
          create.textContent = "Save changes";
          setCreateFeedback(
            error instanceof Error && error.message !== ""
              ? error.message
              : "The test identity could not be updated. It is unchanged.",
            "error",
          );
        });
    };
    create.addEventListener("click", () => {
      clearPanelStatus();
      resetCreateValidation();
      const principal = readFormPrincipal();
      if (principal === null) return;
      const editedKey = editingKey;
      if (editedKey !== null) {
        saveEdit(editedKey, principal);
        return;
      }
      create.disabled = true;
      create.textContent = "Adding…";
      setCreateFeedback(
        `Adding “${principal.id}”, minting its token, and making it active…`,
      );
      void api
        .createPrincipal(principal)
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
        .catch((error: unknown) => {
          if (!active) return;
          create.disabled = false;
          create.textContent = "Add identity";
          setCreateFeedback(
            error instanceof Error && error.message !== ""
              ? error.message
              : "The test identity could not be added. Try again.",
            "error",
          );
        });
    });

    const heading = el("h2", { tabindex: "-1" }, ["Test identities"]);
    const identityCount = principals.length;
    const countLabel = `${String(identityCount)} test ${
      identityCount === 1 ? "identity" : "identities"
    }`;
    const header = el("header", { class: "principals-header" }, [
      el("div", { class: "principals-heading" }, [
        heading,
        el("span", { class: "badge principals-count" }, [countLabel]),
      ]),
      el("p", { class: "hint principals-intro" }, [
        "Manage the development identities the Playground can act as.",
      ]),
    ]);
    const createHeading = el("span", { class: "principal-create-heading" }, [
      "Add identity",
    ]);
    const createOutcome = el(
      "span",
      { class: "hint principal-create-outcome" },
      ["Mints a token and activates it"],
    );
    const createHint = el(
      "p",
      { id: createHintId, class: "hint principal-create-hint" },
      [
        "Create an in-memory Principal for development and homologation. Its bearer token stays hidden in this browser session.",
      ],
    );
    const createSection = el("details", { class: "principal-create" }, [
      el("summary", { class: "principal-create-summary" }, [
        createHeading,
        createOutcome,
      ]),
      el("div", { class: "principal-create-body" }, [
        createHint,
        el("div", { class: "principal-create-fields" }, [
          el("div", { class: "principal-field" }, [
            el("label", { for: idInputId }, ["Principal ID"]),
            idInput,
          ]),
          el("div", { class: "principal-field" }, [
            el("label", { for: attributesInputId }, [
              "Attributes (JSON, optional)",
            ]),
            attributesInput,
          ]),
        ]),
        el(
          "div",
          {
            class: "principal-presets",
            role: "group",
            "aria-label": "Quick-fill presets",
          },
          [el("span", { class: "hint" }, ["Quick fill:"]), ...presetButtons],
        ),
        el("div", { class: "principal-create-actions" }, [create, cancelEdit]),
        feedback,
      ]),
    ]);
    const identitiesSection = el(
      "section",
      {
        class: "principals-list-section",
        "aria-labelledby": "principals-list-heading",
      },
      [
        el("div", { class: "principals-section-heading" }, [
          el("h3", { id: "principals-list-heading" }, ["Available identities"]),
          el("span", { class: "hint" }, [
            identityCount === 0
              ? "No identities configured"
              : `${String(identityCount)} configured`,
          ]),
        ]),
        ...(principals.length === 0
          ? [
              el("p", { class: "empty principal-empty" }, [
                "No test identities yet. Add one to act as it in the Playground.",
              ]),
            ]
          : [el("div", { class: "principals-list" }, rows)]),
      ],
    );
    panelBody.append(
      header,
      el("div", { id: tokenGuidanceId, class: "principal-token-guidance" }, [
        el("strong", { class: "principal-guidance-title" }, [
          "Session credentials",
        ]),
        el("p", { class: "hint" }, [
          "Token values are never displayed and remain in this browser session. Rotating a token revokes the previous token immediately.",
        ]),
      ]),
      identitiesSection,
      createSection,
    );
    recentViews = nextRecentViews;

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

  // The Recent lines read the same stream the Activity panel consumes, which
  // replays the session buffer on connect. They are supplementary, so a
  // browser without the stream still manages identities.
  const source =
    typeof EventSource === "function" ? new EventSource("/api/events") : null;
  source?.addEventListener("trace", (event) => {
    try {
      const entry = JSON.parse((event as MessageEvent<string>).data) as {
        readonly kind?: string;
        readonly call?: RecentCall;
      };
      if (entry.kind !== "adapter" || entry.call === undefined) return;
      recentCalls.unshift(entry.call);
      if (recentCalls.length > recentCallCapacity) recentCalls.pop();
      paintRecent();
    } catch {
      // A malformed frame is dropped; the stream continues.
    }
  });

  return () => {
    active = false;
    source?.close();
  };
}
