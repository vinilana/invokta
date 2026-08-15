import { createCopyButton, formatDuration } from "./clipboard.js";
import { clear, el, pretty } from "./dom.js";
import { exampleFromSchema } from "./example-from-schema.js";
import { createCompactThemeToggle, createThemeToggle } from "./theme.js";
import {
  createBrandLockup,
  createWorkbenchOrientation,
  createWorkbenchSwitch,
  mountedWorkbench,
  workbenchApiBase,
} from "./workbench-chrome.js";

export type AttachedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AttachedJsonValue[]
  | { readonly [key: string]: AttachedJsonValue };

export type AttachedTarget =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
      readonly authentication:
        | { readonly type: "none" }
        | { readonly type: "bearer"; readonly token: string }
        | { readonly type: "oauth" }
        | {
            readonly type: "headers";
            readonly headers: Readonly<Record<string, string>>;
          };
    };

export interface AttachedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, AttachedJsonValue>>;
  readonly outputSchema?: Readonly<Record<string, AttachedJsonValue>>;
  readonly annotations?: Readonly<Record<string, AttachedJsonValue>>;
}

export interface AttachedServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;
}

export interface AttachedConnectionSummary {
  readonly transport: "stdio" | "http";
  readonly server: AttachedServerInfo;
  readonly pageCount: number;
  readonly toolCount: number;
}

export type AttachedConnectionState =
  | {
      readonly state: "idle";
      readonly validation?: {
        readonly status: "error";
        readonly error: { readonly code: string; readonly message: string };
      };
      /**
       * Activity the server retained from the disconnected target. The name
       * matches the `activity` field of the `GET /api/session` idle state.
       */
      readonly activity?: readonly AttachedActivityRecord[];
    }
  | { readonly state: "busy" | "connecting" | "closing" }
  | {
      readonly state: "authorizing";
      readonly authorizationUrl?: string;
    }
  | {
      readonly state: "connected";
      readonly connection?: AttachedConnectionSummary;
    };

export type AttachedSession = AttachedConnectionState & {
  readonly csrfToken: string;
};

export interface AttachedActivityRecord {
  readonly sequence: number | string;
  readonly operation: "initialize" | "tools/list" | "tools/call" | "disconnect";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: string;
  readonly errorCode?: string;
  readonly toolName?: string;
}

export interface AttachedApi {
  session(): Promise<AttachedSession>;
  connect(target: AttachedTarget): Promise<AttachedConnectionState>;
  disconnect(): Promise<AttachedConnectionState>;
  tools(): Promise<readonly AttachedTool[]>;
  callTool(
    name: string,
    argumentsValue: Readonly<Record<string, AttachedJsonValue>>,
  ): Promise<AttachedJsonValue>;
  activity(): Promise<readonly AttachedActivityRecord[]>;
}

export interface StdioTargetDraft {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: readonly Readonly<{
    name: string;
    value: string;
  }>[];
}

export type HttpTargetDraft = {
  readonly url: string;
  readonly authentication:
    | { readonly type: "none" }
    | { readonly type: "bearer"; readonly token: string }
    | { readonly type: "oauth" }
    | {
        readonly type: "headers";
        readonly headers: readonly Readonly<{
          name: string;
          value: string;
        }>[];
      };
};

export interface SecretControl {
  value: string;
  placeholder?: string;
}

export const attachedPrimaryTabs = ["Tools", "Activity", "Connection"] as const;

/** Light refresh cadence while the Activity tab is visible. */
const activityPollDelayMs = 5_000;

type AttachedTab = "tools" | "activity" | "connection";
type Fetcher = typeof fetch;
type RovingOrientation = "horizontal" | "vertical" | "both";
type TargetDraftField =
  | "command"
  | "url"
  | "bearer"
  | "environment-name"
  | "environment-value"
  | "header-name"
  | "header-value";

class TargetDraftValidationError extends Error {
  readonly field: TargetDraftField;
  readonly index: number | undefined;

  constructor(field: TargetDraftField, message: string, index?: number) {
    super(message);
    this.name = "TargetDraftValidationError";
    this.field = field;
    this.index = index;
  }
}

export function nextRovingIndex(
  current: number,
  itemCount: number,
  key: string,
  orientation: RovingOrientation,
): number | undefined {
  if (itemCount <= 0 || current < 0 || current >= itemCount) return undefined;
  let next = current;
  if (
    (orientation === "horizontal" || orientation === "both") &&
    key === "ArrowRight"
  ) {
    next += 1;
  } else if (
    (orientation === "horizontal" || orientation === "both") &&
    key === "ArrowLeft"
  ) {
    next -= 1;
  } else if (
    (orientation === "vertical" || orientation === "both") &&
    key === "ArrowDown"
  ) {
    next += 1;
  } else if (
    (orientation === "vertical" || orientation === "both") &&
    key === "ArrowUp"
  ) {
    next -= 1;
  } else if (key === "Home") {
    return 0;
  } else if (key === "End") {
    return itemCount - 1;
  } else {
    return undefined;
  }
  return (next + itemCount) % itemCount;
}

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const transportOwnedHeaderNames = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

function isTransportOwnedHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    transportOwnedHeaderNames.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("sec-")
  );
}

function nonEmpty(
  value: string,
  message: string,
  field: "command" | "url",
): string {
  const normalized = value.trim();
  if (normalized === "") throw new TargetDraftValidationError(field, message);
  return normalized;
}

export function buildStdioTarget(draft: StdioTargetDraft): AttachedTarget {
  const command = nonEmpty(draft.command, "Command is required.", "command");
  const cwd = draft.cwd?.trim();
  const env = Object.create(null) as Record<string, string>;

  for (const [index, entry] of draft.environment.entries()) {
    const name = entry.name.trim();
    if (!environmentNamePattern.test(name)) {
      throw new TargetDraftValidationError(
        "environment-name",
        "Environment names must use letters, numbers, and underscores.",
        index,
      );
    }
    if (Object.hasOwn(env, name)) {
      throw new TargetDraftValidationError(
        "environment-name",
        "Environment names must be unique.",
        index,
      );
    }
    if (entry.value === "") {
      throw new TargetDraftValidationError(
        "environment-value",
        "Environment values cannot be empty.",
        index,
      );
    }
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      value: entry.value,
      writable: true,
    });
  }

  return {
    transport: "stdio",
    command,
    args: [...draft.args],
    ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
  };
}

export function buildHttpTarget(draft: HttpTargetDraft): AttachedTarget {
  const url = nonEmpty(draft.url, "URL is required.", "url");
  if (draft.authentication.type === "none") {
    return {
      transport: "http",
      url,
      authentication: { type: "none" },
    };
  }

  if (draft.authentication.type === "bearer") {
    const token = draft.authentication.token;
    if (token === "") {
      throw new TargetDraftValidationError(
        "bearer",
        "Bearer token is required.",
      );
    }
    if (token.trim() !== token) {
      throw new TargetDraftValidationError(
        "bearer",
        "Bearer token cannot start or end with whitespace.",
      );
    }
    return {
      transport: "http",
      url,
      authentication: { type: "bearer", token },
    };
  }

  if (draft.authentication.type === "oauth") {
    return {
      transport: "http",
      url,
      authentication: { type: "oauth" },
    };
  }

  if (draft.authentication.headers.length === 0) {
    throw new TargetDraftValidationError(
      "header-name",
      "Add at least one custom header.",
    );
  }
  const headers = Object.create(null) as Record<string, string>;
  const normalizedNames = new Set<string>();
  for (const [index, entry] of draft.authentication.headers.entries()) {
    const name = entry.name.trim();
    if (!headerNamePattern.test(name)) {
      throw new TargetDraftValidationError(
        "header-name",
        "Enter a valid header name.",
        index,
      );
    }
    const normalized = name.toLowerCase();
    if (isTransportOwnedHeader(normalized)) {
      throw new TargetDraftValidationError(
        "header-name",
        "Transport-owned headers cannot be configured here.",
        index,
      );
    }
    if (normalizedNames.has(normalized)) {
      throw new TargetDraftValidationError(
        "header-name",
        "Header names must be unique.",
        index,
      );
    }
    if (entry.value === "") {
      throw new TargetDraftValidationError(
        "header-value",
        "Header values cannot be empty.",
        index,
      );
    }
    if (entry.value.includes("\r") || entry.value.includes("\n")) {
      throw new TargetDraftValidationError(
        "header-value",
        "Header values cannot contain line breaks.",
        index,
      );
    }
    normalizedNames.add(normalized);
    Object.defineProperty(headers, name, {
      configurable: true,
      enumerable: true,
      value: entry.value,
      writable: true,
    });
  }
  return {
    transport: "http",
    url,
    authentication: { type: "headers", headers },
  };
}

function clearSecrets(controls: readonly SecretControl[]): void {
  for (const control of controls) {
    control.value = "";
    control.placeholder = "Cleared after response";
  }
}

export async function completeConnectionAttempt<Value>(
  attempt: Promise<Value>,
  secretControls: readonly SecretControl[],
): Promise<Value> {
  try {
    return await attempt;
  } finally {
    clearSecrets(secretControls);
  }
}

export function filterAttachedTools(
  tools: readonly AttachedTool[],
  query: string,
): readonly AttachedTool[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return tools;
  return tools.filter((tool) =>
    [tool.name, tool.title ?? "", tool.description ?? ""].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

export function parseToolArguments(
  source: string,
): Readonly<Record<string, AttachedJsonValue>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Tool arguments must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed as Readonly<Record<string, AttachedJsonValue>>;
}

export class AttachedApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AttachedApiError";
    this.code = code;
  }
}

async function responseJson<Value>(response: Response): Promise<Value> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new AttachedApiError(
      "PROTOCOL_ERROR",
      "The local interface returned an invalid response.",
    );
  }
  if (!response.ok) {
    const error = value as {
      readonly code?: unknown;
      readonly message?: unknown;
    };
    throw new AttachedApiError(
      typeof error.code === "string" ? error.code : "CONNECTION_FAILED",
      typeof error.message === "string"
        ? error.message
        : "The local request could not be completed.",
    );
  }
  return value as Value;
}

/**
 * Adapts the ADR 0022 loopback routes while keeping the session CSRF token in
 * this closure. No target descriptor or credential is written to storage.
 */
export function createRouteAttachedApi(
  fetcher: Fetcher = fetch,
  apiBase: string = workbenchApiBase(),
): AttachedApi {
  let csrfToken = "";

  const get = async <Value>(path: string): Promise<Value> => {
    const response = await fetcher(path, { credentials: "same-origin" });
    return responseJson<Value>(response);
  };

  const mutate = async <Value>(
    path: string,
    method: "POST" | "DELETE",
    body?: unknown,
  ): Promise<Value> => {
    const response = await fetcher(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "X-Invokta-CSRF": csrfToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await responseJson<Value>(response);
    const replacement = response.headers.get("X-Invokta-CSRF");
    if (replacement !== null && replacement !== "") csrfToken = replacement;
    return value;
  };

  return {
    async session() {
      const response = await get<AttachedSession>(`${apiBase}/session`);
      csrfToken = response.csrfToken;
      return response;
    },
    connect: (target) =>
      mutate<AttachedConnectionState>(`${apiBase}/connection`, "POST", target),
    disconnect: () =>
      mutate<AttachedConnectionState>(`${apiBase}/connection`, "DELETE"),
    async tools() {
      const response = await get<{ readonly tools: readonly AttachedTool[] }>(
        `${apiBase}/tools`,
      );
      return response.tools;
    },
    async callTool(name, argumentsValue) {
      const response = await mutate<{ readonly response: AttachedJsonValue }>(
        `${apiBase}/tools/call`,
        "POST",
        { name, arguments: argumentsValue },
      );
      return response.response;
    },
    async activity() {
      const response = await get<{
        readonly records: readonly AttachedActivityRecord[];
      }>(`${apiBase}/activity`);
      return response.records;
    },
  };
}

let controlSequence = 0;

function controlId(name: string): string {
  controlSequence += 1;
  return `attached-${name}-${String(controlSequence)}`;
}

function labelFor(
  text: string,
  id: string,
  className = "att-label",
): HTMLLabelElement {
  return el("label", { for: id, class: className }, [text]);
}

function textInput(options: {
  readonly label: string;
  readonly name: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly type?: "text" | "search" | "password";
  readonly autocomplete?: string;
}): { readonly field: HTMLDivElement; readonly input: HTMLInputElement } {
  const id = controlId(options.name);
  const input = el("input", {
    id,
    class: "att-input",
    type: options.type ?? "text",
    ...(options.placeholder === undefined
      ? {}
      : { placeholder: options.placeholder }),
    ...(options.autocomplete === undefined
      ? {}
      : { autocomplete: options.autocomplete }),
  });
  input.value = options.value ?? "";
  return {
    field: el("div", {}, [labelFor(options.label, id), input]),
    input,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local request could not be completed.";
}

const annotationLabels: Readonly<Record<string, string>> = {
  readOnlyHint: "Read-only",
  destructiveHint: "Destructive",
  idempotentHint: "Idempotent",
  openWorldHint: "Open world",
};

/** Advertised behavior hints, shown before a call so intent is visible. */
function annotationTags(
  annotations: Readonly<Record<string, AttachedJsonValue>> | undefined,
): readonly HTMLElement[] {
  return Object.entries(annotations ?? {})
    .filter(([, value]) => value === true)
    .map(([name]) =>
      el(
        "span",
        {
          class: `att-tag${name === "destructiveHint" ? " danger" : ""}`,
        },
        [annotationLabels[name] ?? name],
      ),
    );
}

/**
 * A starter argument object drawn from the advertised input schema so the
 * editor opens on real field names. It is a seed, not a validated value; the
 * attached server remains the only authority on its own schema.
 */
export function seedArguments(
  schema: Readonly<Record<string, AttachedJsonValue>>,
): string {
  const example = exampleFromSchema(schema);
  if (typeof example !== "object" || example === null || Array.isArray(example))
    return "{}";
  return pretty(example);
}

/** Splits an ISO instant into a scannable clock reading and its full value. */
function clockReading(instant: string): string {
  const separator = instant.indexOf("T");
  if (separator === -1) return instant;
  return instant.slice(separator + 1).replace("Z", "");
}

/**
 * Reads the activity a server may retain from a disconnected target. The field
 * is optional, so the workbench degrades to showing nothing when the server
 * exposes no retained records.
 */
export function retainedActivityOf(
  state: AttachedConnectionState,
): readonly AttachedActivityRecord[] {
  if (state.state !== "idle") return [];
  return Array.isArray(state.activity) ? state.activity : [];
}

/** Protocol-operation table shared by the Activity tab and the idle recap. */
function activityTable(
  records: readonly AttachedActivityRecord[],
): HTMLElement {
  const body = el(
    "tbody",
    {},
    records.map((record) =>
      el("tr", {}, [
        el("td", { class: "att-mono" }, [String(record.sequence)]),
        el("td", {}, [record.operation]),
        el("td", { class: "att-mono" }, [record.toolName ?? "—"]),
        el("td", { class: "att-mono", title: record.startedAt }, [
          clockReading(record.startedAt),
        ]),
        el("td", { class: "att-mono att-numeric" }, [
          `${String(record.durationMs)} ms`,
        ]),
        el(
          "td",
          {
            class: `att-status-text ${record.outcome === "success" ? "success" : "error"}`,
          },
          [record.errorCode ?? record.outcome],
        ),
      ]),
    ),
  );
  return el("table", { class: "att-activity-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Sequence"]),
        el("th", { scope: "col" }, ["Operation"]),
        el("th", { scope: "col" }, ["Tool"]),
        el("th", { scope: "col" }, ["Started"]),
        el("th", { scope: "col" }, ["Duration"]),
        el("th", { scope: "col" }, ["Outcome"]),
      ]),
    ]),
    body,
  ]);
}

function statusPill(state: AttachedConnectionState): HTMLElement {
  const label =
    state.state === "connected"
      ? "Connected"
      : state.state === "idle"
        ? "Not connected"
        : state.state === "busy"
          ? "Target busy"
          : state.state === "connecting"
            ? "Connecting"
            : state.state === "authorizing"
              ? "Authorizing"
              : "Closing";
  const tone =
    state.state === "connected"
      ? "success"
      : state.state === "idle"
        ? ""
        : "warning";
  return el(
    "span",
    {
      class: `att-pill ${tone}`.trim(),
      role: "status",
      "aria-live": "polite",
    },
    [el("span", { class: "att-dot", "aria-hidden": "true" }, []), label],
  );
}

export interface AttachedAppHandle {
  destroy(): void;
}

export function mountAttachedApp(
  root: HTMLElement,
  api: AttachedApi = createRouteAttachedApi(),
): AttachedAppHandle {
  type EditablePair = SecretControl & { name: string };
  const ownerDocument = root.ownerDocument;
  // Present only when the launcher mounted both workbenches on this origin.
  const launchedWorkbench = mountedWorkbench(ownerDocument);
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
  let targetState: AttachedConnectionState = { state: "idle" };
  let activeTab: AttachedTab = "tools";
  let tools: readonly AttachedTool[] = [];
  let toolsLoaded = false;
  let toolsLoading = false;
  let toolsError = "";
  let selectedToolName: string | undefined;
  let toolQuery = "";
  let activity: readonly AttachedActivityRecord[] = [];
  let activityLoaded = false;
  let activityLoading = false;
  let activityError = "";
  let activityPoll: ReturnType<typeof setInterval> | undefined;
  let connectionError = "";
  let secretConfigured = false;
  let oauthAuthorizationUrl: string | undefined;
  let oauthFlowActive = false;
  let authorizationPollingPaused = false;
  let authorizationPollFailures = 0;
  let authorizationPoll: ReturnType<typeof setTimeout> | undefined;
  let authorizationPollGeneration = 0;
  const stdioDraft: {
    command: string;
    args: string[];
    cwd: string;
    environment: EditablePair[];
  } = { command: "", args: [], cwd: "", environment: [] };
  const bearerSecret: SecretControl = { value: "", placeholder: "" };
  const httpDraft: {
    url: string;
    authentication: "none" | "bearer" | "oauth" | "headers";
    headers: EditablePair[];
  } = { url: "", authentication: "none", headers: [] };
  let transport: "stdio" | "http" = "stdio";
  const fullThemeToggle = createThemeToggle();
  const compactThemeToggle = createCompactThemeToggle();
  const argumentDrafts = new Map<string, string>();
  let currentResult:
    | { readonly toolName: string; readonly value: AttachedJsonValue }
    | undefined;

  const render = (): void => {
    if (destroyed) return;
    if (targetState.state === "idle") renderIdle();
    else if (
      targetState.state === "connected" &&
      targetState.connection !== undefined
    ) {
      renderConnected();
    } else {
      renderUnavailableState();
    }
  };

  const stopAuthorizationPolling = (): void => {
    authorizationPollGeneration += 1;
    if (authorizationPoll !== undefined) clearTimeout(authorizationPoll);
    authorizationPoll = undefined;
  };

  const startAuthorizationPolling = (): void => {
    stopAuthorizationPolling();
    authorizationPollingPaused = false;
    authorizationPollFailures = 0;
    const generation = authorizationPollGeneration;
    const poll = (delayMs = 750): void => {
      authorizationPoll = setTimeout(() => {
        void api
          .session()
          .then((session) => {
            if (destroyed || generation !== authorizationPollGeneration) return;
            if (session.state === "authorizing") {
              targetState = { state: "authorizing" };
            } else if (oauthFlowActive && session.state === "connecting") {
              targetState = { state: "authorizing" };
            } else {
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
                        ...(retained.length === 0
                          ? {}
                          : { activity: retained }),
                      }
                    : { state: session.state };
            }
            if (targetState.state === "authorizing") {
              authorizationPollFailures = 0;
              connectionError = "";
              poll();
              return;
            }
            oauthAuthorizationUrl = undefined;
            oauthFlowActive = false;
            authorizationPollingPaused = false;
            authorizationPollFailures = 0;
            stopAuthorizationPolling();
            connectionError =
              targetState.state === "idle"
                ? (targetState.validation?.error.message ?? "")
                : "";
            render();
            if (
              targetState.state === "idle" &&
              targetState.validation !== undefined
            ) {
              root
                .querySelector<HTMLInputElement>('input[name="url"]')
                ?.focus();
            }
            if (
              targetState.state === "connected" &&
              targetState.connection !== undefined
            ) {
              secretConfigured = true;
              void loadTools();
            }
          })
          .catch(() => {
            if (destroyed || generation !== authorizationPollGeneration) return;
            authorizationPollFailures += 1;
            if (authorizationPollFailures < 3) {
              poll(750 * 2 ** authorizationPollFailures);
              return;
            }
            const focusedAction = (
              ownerDocument.activeElement as HTMLElement | null
            )?.dataset.attOauthAction;
            authorizationPollingPaused = true;
            connectionError =
              "Status checks paused after repeated local request failures.";
            render();
            if (focusedAction !== undefined) {
              root
                .querySelector<HTMLElement>(
                  `[data-att-oauth-action="${focusedAction}"]`,
                )
                ?.focus();
            }
          });
      }, delayMs);
    };
    poll();
  };

  const createTabs = (): HTMLElement => {
    const buttons: HTMLButtonElement[] = [];
    const nav = el(
      "nav",
      {
        class: "att-tabs",
        role: "tablist",
        "aria-label": "Attached server sections",
        "aria-orientation": "horizontal",
      },
      attachedPrimaryTabs.map((label) => {
        const name = label.toLowerCase() as AttachedTab;
        const button = el(
          "button",
          {
            type: "button",
            role: "tab",
            id: `attached-tab-${name}`,
            "aria-controls": `attached-panel-${name}`,
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
      const tab = attachedPrimaryTabs.at(
        (next + attachedPrimaryTabs.length) % attachedPrimaryTabs.length,
      );
      if (destination === undefined || tab === undefined) return;
      void selectTab(tab.toLowerCase() as AttachedTab).then(() => {
        ownerDocument.getElementById(destination.id)?.focus();
      });
    });
    return nav;
  };

  const shell = (content: HTMLElement, includeTabs: boolean): void => {
    const topbarChildren: Node[] = [createBrandLockup(launchedWorkbench)];
    if (launchedWorkbench !== undefined) {
      topbarChildren.push(createWorkbenchSwitch(launchedWorkbench));
    }
    if (includeTabs) topbarChildren.push(createTabs());
    else
      topbarChildren.push(
        el("span", { class: "att-topbar-spacer", "aria-hidden": "true" }, []),
      );
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
        ? targetState.connection.server.name
        : "MCP workbench";
    const context = el("section", { class: "att-context" }, [
      el("div", { class: "att-frame att-context-inner" }, [
        el("div", { class: "att-context-title" }, [
          el("p", { class: "att-kicker" }, ["MCP workbench"]),
          el("h1", {}, [heading]),
        ]),
        el("div", { class: "att-context-meta" }, [
          statusPill(targetState),
          ...(targetState.state === "connected" &&
          targetState.connection !== undefined
            ? [
                el("span", { class: "att-pill" }, [
                  targetState.connection.transport === "stdio"
                    ? "stdio"
                    : "HTTP",
                ]),
                el("span", { class: "att-pill" }, [
                  `${String(targetState.connection.toolCount)} tools`,
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

  function renderIdle(): void {
    const intro = el("section", { class: "att-idle-intro" }, [
      el("p", { class: "att-kicker" }, ["Connection"]),
      el("h2", {}, ["Attach one MCP server"]),
      el("p", {}, [
        "Use an explicit local command or Streamable HTTP endpoint. Connection validates initialization and the complete tool catalog.",
      ]),
      el("p", { class: "att-hint" }, [
        "Nothing is discovered, imported, invoked, or saved automatically.",
      ]),
    ]);
    const formHost = el("section", {
      class: "att-idle-form",
      "aria-label": "Connection details",
    });

    const paintForm = (): void => {
      clear(formHost);
      const validationFields = new Map<string, HTMLInputElement>();
      const validationKey = (field: TargetDraftField, index?: number): string =>
        `${field}:${index === undefined ? "single" : String(index)}`;
      const feedback = el("p", {
        id: controlId("connection-feedback"),
        class: "att-feedback",
        role: "alert",
        "aria-live": "assertive",
      });
      feedback.textContent = connectionError;
      const registerValidationField = (
        field: TargetDraftField,
        input: HTMLInputElement,
        index?: number,
      ): void => {
        validationFields.set(validationKey(field, index), input);
        input.addEventListener("input", () => {
          if (input.getAttribute("aria-invalid") !== "true") return;
          input.removeAttribute("aria-invalid");
          input.removeAttribute("aria-errormessage");
          feedback.textContent = "";
        });
      };
      const focusRadio = (group: string, value: string): void => {
        const radio = Array.from(
          formHost.querySelectorAll<HTMLButtonElement>(
            `[data-att-radio-group="${group}"]`,
          ),
        ).find((candidate) => candidate.dataset.attRadioValue === value);
        radio?.focus();
      };
      const transportFieldset = el("fieldset", { class: "att-fieldset" }, [
        el("legend", {}, ["Transport"]),
      ]);
      const transportOptions = ["stdio", "http"] as const;
      const selectTransport = (
        option: (typeof transportOptions)[number],
        focus: boolean,
      ): void => {
        if (transport !== option) {
          clearSecrets([
            ...stdioDraft.environment,
            bearerSecret,
            ...httpDraft.headers,
          ]);
          transport = option;
          paintForm();
        }
        if (focus) focusRadio("transport", option);
      };
      const transportButtons = transportOptions.map((option) => {
        const button = el(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": String(transport === option),
            tabindex: transport === option ? "0" : "-1",
            "data-att-radio-group": "transport",
            "data-att-radio-value": option,
          },
          [option === "stdio" ? "stdio" : "HTTP"],
        );
        button.addEventListener("click", () => {
          selectTransport(option, true);
        });
        return button;
      });
      const segmented = el(
        "div",
        {
          class: "att-segmented",
          role: "radiogroup",
          "aria-label": "Transport",
        },
        transportButtons,
      );
      segmented.addEventListener("keydown", (event) => {
        const current = transportButtons.indexOf(
          event.target as HTMLButtonElement,
        );
        const next = nextRovingIndex(
          current,
          transportButtons.length,
          event.key,
          "both",
        );
        if (next === undefined) return;
        event.preventDefault();
        const option = transportOptions[next];
        if (option !== undefined) selectTransport(option, true);
      });
      transportFieldset.append(segmented);

      const form = el("form", {}, [transportFieldset]);

      const addArgumentRows = (
        host: HTMLElement,
        fallbackFocus?: HTMLElement,
        focusIndex?: number,
      ): void => {
        clear(host);
        for (const [index, argument] of stdioDraft.args.entries()) {
          const id = controlId("argument");
          const input = el("input", {
            id,
            class: "att-input",
            type: "text",
            "aria-label": `Argument ${String(index + 1)}`,
          });
          input.value = argument;
          input.addEventListener("input", () => {
            stdioDraft.args[index] = input.value;
          });
          const remove = el(
            "button",
            {
              type: "button",
              class: "att-button att-icon-button",
              "aria-label": `Remove argument ${String(index + 1)}`,
              title: "Remove argument",
            },
            ["Remove"],
          );
          remove.addEventListener("click", () => {
            stdioDraft.args.splice(index, 1);
            const nextIndex = Math.min(index, stdioDraft.args.length - 1);
            addArgumentRows(
              host,
              fallbackFocus,
              nextIndex >= 0 ? nextIndex : undefined,
            );
            if (nextIndex < 0) fallbackFocus?.focus();
          });
          host.append(
            el("div", { class: "att-inline-fields single" }, [
              el("div", {}, [
                labelFor(`Argument ${String(index + 1)}`, id),
                input,
              ]),
              remove,
            ]),
          );
        }
        if (focusIndex !== undefined) {
          host
            .querySelector<HTMLInputElement>(
              `[aria-label="Argument ${String(focusIndex + 1)}"]`,
            )
            ?.focus();
        }
      };

      const addPairRows = (
        host: HTMLElement,
        pairs: EditablePair[],
        kind: "environment" | "header",
        fallbackFocus?: HTMLElement,
        focusIndex?: number,
      ): void => {
        clear(host);
        for (const [index, pair] of pairs.entries()) {
          const nameField = textInput({
            label: kind === "environment" ? "Variable name" : "Header name",
            name: `${kind}-name`,
            value: pair.name,
            placeholder: kind === "environment" ? "API_TOKEN" : "X-API-Key",
          });
          const valueField = textInput({
            label: kind === "environment" ? "Variable value" : "Header value",
            name: `${kind}-value`,
            value: pair.value,
            ...(pair.placeholder === undefined
              ? {}
              : { placeholder: pair.placeholder }),
            type: "password",
            autocomplete: "off",
          });
          nameField.input.addEventListener("input", () => {
            pair.name = nameField.input.value;
          });
          valueField.input.addEventListener("input", () => {
            pair.value = valueField.input.value;
          });
          registerValidationField(`${kind}-name`, nameField.input, index);
          registerValidationField(`${kind}-value`, valueField.input, index);
          const remove = el(
            "button",
            {
              type: "button",
              class: "att-button att-icon-button",
              "aria-label": `Remove ${kind} row ${String(index + 1)}`,
              title: `Remove ${kind} row`,
            },
            ["Remove"],
          );
          remove.addEventListener("click", () => {
            clearSecrets([pair, valueField.input]);
            pairs.splice(index, 1);
            const nextIndex = Math.min(index, pairs.length - 1);
            addPairRows(
              host,
              pairs,
              kind,
              fallbackFocus,
              nextIndex >= 0 ? nextIndex : undefined,
            );
            if (nextIndex < 0) fallbackFocus?.focus();
          });
          host.append(
            el("div", { class: "att-inline-fields" }, [
              nameField.field,
              valueField.field,
              remove,
            ]),
          );
        }
        if (focusIndex !== undefined) {
          validationFields
            .get(validationKey(`${kind}-name`, focusIndex))
            ?.focus();
        }
      };

      if (transport === "stdio") {
        const command = textInput({
          label: "Command",
          name: "command",
          value: stdioDraft.command,
          placeholder: "node",
          autocomplete: "off",
        });
        command.input.required = true;
        command.input.addEventListener("input", () => {
          stdioDraft.command = command.input.value;
        });
        registerValidationField("command", command.input);
        const cwd = textInput({
          label: "Working directory",
          name: "cwd",
          value: stdioDraft.cwd,
          placeholder: "Optional absolute directory",
          autocomplete: "off",
        });
        cwd.input.addEventListener("input", () => {
          stdioDraft.cwd = cwd.input.value;
        });
        const argumentsHost = el("div", {}, []);
        const addArgument = el(
          "button",
          { type: "button", class: "att-button" },
          ["Add argument"],
        );
        addArgument.addEventListener("click", () => {
          stdioDraft.args.push("");
          addArgumentRows(
            argumentsHost,
            addArgument,
            stdioDraft.args.length - 1,
          );
        });
        addArgumentRows(argumentsHost, addArgument);
        const environmentHost = el("div", {}, []);
        const addEnvironment = el(
          "button",
          { type: "button", class: "att-button" },
          ["Add environment variable"],
        );
        addEnvironment.addEventListener("click", () => {
          stdioDraft.environment.push({ name: "", value: "", placeholder: "" });
          addPairRows(
            environmentHost,
            stdioDraft.environment,
            "environment",
            addEnvironment,
            stdioDraft.environment.length - 1,
          );
        });
        addPairRows(
          environmentHost,
          stdioDraft.environment,
          "environment",
          addEnvironment,
        );
        form.append(
          command.field,
          cwd.field,
          el("div", { class: "att-section-heading" }, [
            el("h3", {}, ["Arguments"]),
            el("span", { class: "att-hint" }, ["One exact value per row"]),
          ]),
          argumentsHost,
          addArgument,
          el("div", { class: "att-section-heading" }, [
            el("h3", {}, ["Environment"]),
            el("span", { class: "att-hint" }, ["Values stay in memory"]),
          ]),
          environmentHost,
          addEnvironment,
        );
      } else {
        const url = textInput({
          label: "Streamable HTTP URL",
          name: "url",
          value: httpDraft.url,
          placeholder: "https://mcp.example.com/mcp",
          autocomplete: "url",
        });
        url.input.required = true;
        url.input.addEventListener("input", () => {
          httpDraft.url = url.input.value;
        });
        registerValidationField("url", url.input);
        const authFieldset = el("fieldset", { class: "att-fieldset" }, [
          el("legend", {}, ["Authentication"]),
        ]);
        const authenticationOptions = [
          ["none", "None"],
          ["bearer", "Bearer"],
          ["oauth", "OAuth"],
          ["headers", "Custom headers"],
        ] as const;
        const selectAuthentication = (
          value: (typeof authenticationOptions)[number][0],
          focus: boolean,
        ): void => {
          if (httpDraft.authentication !== value) {
            clearSecrets([bearerSecret, ...httpDraft.headers]);
            httpDraft.authentication = value;
            paintForm();
          }
          if (focus) focusRadio("authentication", value);
        };
        const authenticationButtons = authenticationOptions.map(
          ([value, label]) => {
            const button = el(
              "button",
              {
                type: "button",
                role: "radio",
                "aria-checked": String(httpDraft.authentication === value),
                tabindex: httpDraft.authentication === value ? "0" : "-1",
                "data-att-radio-group": "authentication",
                "data-att-radio-value": value,
              },
              [label],
            );
            button.addEventListener("click", () => {
              selectAuthentication(value, true);
            });
            return button;
          },
        );
        const authChoices = el(
          "div",
          {
            class: "att-segmented att-auth-options",
            role: "radiogroup",
            "aria-label": "HTTP authentication",
          },
          authenticationButtons,
        );
        authChoices.addEventListener("keydown", (event) => {
          const current = authenticationButtons.indexOf(
            event.target as HTMLButtonElement,
          );
          const next = nextRovingIndex(
            current,
            authenticationButtons.length,
            event.key,
            "both",
          );
          if (next === undefined) return;
          event.preventDefault();
          const option = authenticationOptions[next]?.[0];
          if (option !== undefined) selectAuthentication(option, true);
        });
        authFieldset.append(authChoices);
        form.append(url.field, authFieldset);

        if (httpDraft.authentication === "bearer") {
          const bearer = textInput({
            label: "Bearer token",
            name: "bearer-token",
            value: bearerSecret.value,
            ...(bearerSecret.placeholder === undefined
              ? {}
              : { placeholder: bearerSecret.placeholder }),
            type: "password",
            autocomplete: "off",
          });
          bearer.input.required = true;
          bearer.input.addEventListener("input", () => {
            bearerSecret.value = bearer.input.value;
          });
          registerValidationField("bearer", bearer.input);
          form.append(bearer.field);
        } else if (httpDraft.authentication === "oauth") {
          form.append(
            el("div", { class: "att-callout" }, [
              "After Connect, open the provider authorization page. OAuth material stays in process memory and is cleared when the attempt ends.",
            ]),
          );
        } else if (httpDraft.authentication === "headers") {
          const headerHost = el("div", {}, []);
          if (httpDraft.headers.length === 0) {
            httpDraft.headers.push({ name: "", value: "", placeholder: "" });
          }
          const addHeader = el(
            "button",
            { type: "button", class: "att-button" },
            ["Add custom header"],
          );
          addHeader.addEventListener("click", () => {
            httpDraft.headers.push({ name: "", value: "", placeholder: "" });
            addPairRows(
              headerHost,
              httpDraft.headers,
              "header",
              addHeader,
              httpDraft.headers.length - 1,
            );
          });
          addPairRows(headerHost, httpDraft.headers, "header", addHeader);
          form.append(headerHost, addHeader);
        }
      }

      const connect = el(
        "button",
        { type: "submit", class: "att-button primary" },
        ["Connect"],
      );
      form.append(el("div", { class: "att-actions" }, [connect]), feedback);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        feedback.textContent = "";
        let target: AttachedTarget;
        let secretControls: SecretControl[];
        try {
          if (transport === "stdio") {
            target = buildStdioTarget({
              command: stdioDraft.command,
              args: stdioDraft.args,
              cwd: stdioDraft.cwd,
              environment: stdioDraft.environment,
            });
            secretControls = [...stdioDraft.environment];
          } else if (httpDraft.authentication === "bearer") {
            target = buildHttpTarget({
              url: httpDraft.url,
              authentication: { type: "bearer", token: bearerSecret.value },
            });
            secretControls = [bearerSecret];
          } else if (httpDraft.authentication === "headers") {
            target = buildHttpTarget({
              url: httpDraft.url,
              authentication: {
                type: "headers",
                headers: httpDraft.headers,
              },
            });
            secretControls = [...httpDraft.headers];
          } else if (httpDraft.authentication === "oauth") {
            target = buildHttpTarget({
              url: httpDraft.url,
              authentication: { type: "oauth" },
            });
            secretControls = [];
          } else {
            target = buildHttpTarget({
              url: httpDraft.url,
              authentication: { type: "none" },
            });
            secretControls = [];
          }
        } catch (error) {
          feedback.textContent = errorMessage(error);
          if (error instanceof TargetDraftValidationError) {
            const input = validationFields.get(
              validationKey(error.field, error.index),
            );
            if (input !== undefined) {
              input.setAttribute("aria-invalid", "true");
              input.setAttribute("aria-errormessage", feedback.id);
              input.focus();
            }
          }
          return;
        }

        const passwordInputs = Array.from(
          form.querySelectorAll<HTMLInputElement>('input[type="password"]'),
        );
        const carriesSecrets = secretControls.length > 0;
        connect.disabled = true;
        connect.textContent = "Connecting…";
        void completeConnectionAttempt(api.connect(target), [
          ...secretControls,
          ...passwordInputs,
        ])
          .then((state) => {
            targetState = state;
            secretConfigured =
              carriesSecrets || httpDraft.authentication === "oauth";
            connectionError = "";
            oauthAuthorizationUrl =
              state.state === "authorizing"
                ? state.authorizationUrl
                : undefined;
            oauthFlowActive = state.state === "authorizing";
            render();
            if (targetState.state === "authorizing") {
              startAuthorizationPolling();
              root
                .querySelector<HTMLElement>("[data-att-oauth-heading]")
                ?.focus();
            }
            if (
              targetState.state === "connected" &&
              targetState.connection !== undefined
            ) {
              void loadTools();
            }
          })
          .catch((error: unknown) => {
            connect.disabled = false;
            connect.textContent = "Connect";
            feedback.textContent = errorMessage(error);
          });
      });
      const orientation = el("aside", { class: "att-idle-orient" }, [
        el("h3", {}, ["This is the MCP workbench."]),
        el("p", {}, [
          "It inspects an installed MCP server without loading an engine.",
        ]),
        createWorkbenchOrientation(launchedWorkbench),
        el("dl", { class: "att-idle-orient-paths" }, [
          ...(launchedWorkbench === undefined
            ? [
                el("dt", {}, ["CLI workbench"]),
                el("dd", {}, [
                  el("div", { class: "att-mono" }, [
                    "invokta-devtools open --cli",
                  ]),
                ]),
              ]
            : []),
          el("dt", {}, ["Project workspace"]),
          el("dd", {}, [
            el("div", { class: "att-mono" }, [
              "invokta-devtools serve dist/engine.js",
            ]),
            el("div", {}, ["or yarn devtools inside an engine repo"]),
          ]),
        ]),
      ]);
      formHost.append(form, orientation);
    };

    paintForm();
    const card = el("div", { class: "att-card att-idle" }, [intro, formHost]);
    const retained = retainedActivityOf(targetState);
    if (retained.length === 0) {
      shell(card, false);
      return;
    }
    shell(
      el("div", {}, [
        card,
        el(
          "section",
          {
            class: "att-card att-view att-retained",
            "aria-label": "Activity retained from the disconnected target",
          },
          [
            el("div", { class: "att-section-heading" }, [
              el("div", {}, [
                el("h2", {}, ["Last session activity"]),
                el("span", { class: "att-hint" }, [
                  "Protocol operations retained from the disconnected target",
                ]),
              ]),
              el("span", { class: "att-pill" }, [
                `${String(retained.length)} ${retained.length === 1 ? "operation" : "operations"}`,
              ]),
            ]),
            activityTable(retained),
          ],
        ),
      ]),
      false,
    );
  }

  function renderUnavailableState(): void {
    if (targetState.state === "authorizing") {
      const cancel = el(
        "button",
        { type: "button", class: "att-button danger" },
        ["Cancel"],
      );
      const feedback = el("p", {
        class: "att-feedback",
        role: "alert",
        "aria-live": "assertive",
      });
      feedback.textContent = connectionError;
      cancel.addEventListener("click", () => {
        cancel.disabled = true;
        cancel.textContent = "Cancelling…";
        stopAuthorizationPolling();
        void api
          .disconnect()
          .then((state) => {
            targetState = state;
            oauthAuthorizationUrl = undefined;
            oauthFlowActive = false;
            authorizationPollingPaused = false;
            secretConfigured = false;
            connectionError = "";
            render();
            root.querySelector<HTMLInputElement>('input[name="url"]')?.focus();
          })
          .catch((error: unknown) => {
            cancel.disabled = false;
            cancel.textContent = "Cancel";
            connectionError = errorMessage(error);
            feedback.textContent = connectionError;
            startAuthorizationPolling();
            root
              .querySelector<HTMLButtonElement>("[data-att-oauth-cancel]")
              ?.focus();
          });
      });
      const actions: Node[] = [];
      if (oauthAuthorizationUrl !== undefined) {
        const continueAuthorization = el(
          "a",
          {
            class: "att-button primary",
            href: oauthAuthorizationUrl,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          ["Continue authorization"],
        );
        continueAuthorization.dataset.attOauthAction = "continue";
        actions.push(continueAuthorization);
      }
      if (authorizationPollingPaused) {
        const retryStatus = el(
          "button",
          { type: "button", class: "att-button" },
          ["Retry status"],
        );
        retryStatus.dataset.attOauthAction = "retry";
        retryStatus.addEventListener("click", () => {
          connectionError = "";
          startAuthorizationPolling();
          render();
          root
            .querySelector<HTMLButtonElement>("[data-att-oauth-cancel]")
            ?.focus();
        });
        actions.push(retryStatus);
      }
      actions.push(cancel);
      const heading = el(
        "h2",
        { tabindex: "-1", "data-att-oauth-heading": "true" },
        ["Complete OAuth authorization"],
      );
      const authorizationOrigin =
        oauthAuthorizationUrl === undefined
          ? undefined
          : new URL(oauthAuthorizationUrl).origin;
      cancel.dataset.attOauthCancel = "true";
      cancel.dataset.attOauthAction = "cancel";
      shell(
        el("section", { class: "att-card att-view att-oauth" }, [
          el("p", { class: "att-kicker" }, ["Connection"]),
          heading,
          el("p", { class: "att-hint" }, [
            oauthAuthorizationUrl === undefined
              ? "The authorization link is not available after refresh. If the provider tab is unavailable, cancel and connect again."
              : "Continue in the provider tab, then return here.",
          ]),
          authorizationOrigin === undefined
            ? null
            : el("p", { class: "att-hint" }, [
                "Authorization provider ",
                el("code", {}, [authorizationOrigin]),
              ]),
          el(
            "p",
            {
              class: "att-oauth-status",
              role: "status",
              "aria-live": "polite",
            },
            [
              authorizationPollingPaused
                ? "Status polling is paused."
                : "Waiting for the OAuth callback…",
            ],
          ),
          el("div", { class: "att-actions" }, actions),
          feedback,
        ]),
        false,
      );
      return;
    }
    const label =
      targetState.state === "connecting"
        ? "A connection is being established."
        : targetState.state === "closing"
          ? "The current connection is closing."
          : "A target is connected in another local browser session.";
    shell(
      el("section", { class: "att-card att-view" }, [
        el("p", { class: "att-kicker" }, ["Connection"]),
        el("h2", {}, ["Target slot unavailable"]),
        el("p", { class: "att-hint" }, [label]),
        el("p", { class: "att-hint" }, [
          "Only the browser session that connected the target can inspect or disconnect it.",
        ]),
      ]),
      false,
    );
  }

  function renderConnected(): void {
    let panel: HTMLElement;
    if (activeTab === "activity") panel = renderActivityPanel();
    else if (activeTab === "connection") panel = renderConnectionPanel();
    else panel = renderToolsPanel();
    panel.id = `attached-panel-${activeTab}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `attached-tab-${activeTab}`);
    panel.setAttribute("tabindex", "0");
    shell(el("div", { class: "att-card att-workbench" }, [panel]), true);
  }

  function renderToolsPanel(): HTMLElement {
    if (toolsLoading && !toolsLoaded) {
      return el("section", { class: "att-loading" }, ["Loading tools…"]);
    }
    if (toolsError !== "" && !toolsLoaded) {
      const retry = el("button", { type: "button", class: "att-button" }, [
        "Refresh catalog",
      ]);
      retry.addEventListener("click", () => void loadTools());
      return el("section", { class: "att-view" }, [
        el("h2", {}, ["Tools unavailable"]),
        el("p", { class: "att-feedback", role: "alert" }, [toolsError]),
        retry,
      ]);
    }

    if (
      selectedToolName === undefined ||
      !tools.some(({ name }) => name === selectedToolName)
    ) {
      selectedToolName = tools[0]?.name;
    }
    const sidebar = el("aside", { class: "att-tool-sidebar" }, [
      el("h2", {}, ["Tools"]),
      el("p", { class: "att-hint" }, [
        `${String(tools.length)} advertised tools`,
      ]),
    ]);
    const search = textInput({
      label: "Search tools",
      name: "tool-search",
      value: toolQuery,
      placeholder: "Name, title, or description",
      type: "search",
      autocomplete: "off",
    });
    const list = el(
      "div",
      {
        class: "att-tool-list",
        role: "listbox",
        "aria-label": "Connected MCP tools",
      },
      [],
    );
    let visibleTools: readonly AttachedTool[] = [];
    let choiceButtons: HTMLButtonElement[] = [];
    const focusToolChoice = (name: string): void => {
      Array.from(root.querySelectorAll<HTMLButtonElement>(".att-tool-choice"))
        .find((candidate) => candidate.dataset.toolName === name)
        ?.focus();
    };
    const selectTool = (name: string, focus: boolean): void => {
      selectedToolName = name;
      render();
      if (focus) focusToolChoice(name);
    };
    const paintTools = (): void => {
      clear(list);
      const matches = filterAttachedTools(tools, search.input.value);
      visibleTools = matches;
      choiceButtons = [];
      if (matches.length === 0) {
        list.append(el("p", { class: "att-empty" }, ["No matching tools."]));
        return;
      }
      const rovingName = matches.some(({ name }) => name === selectedToolName)
        ? selectedToolName
        : matches[0]?.name;
      for (const tool of matches) {
        const choice = el(
          "button",
          {
            type: "button",
            class: "att-tool-choice",
            role: "option",
            "aria-selected": String(tool.name === selectedToolName),
            "aria-controls": "attached-tool-detail",
            tabindex: tool.name === rovingName ? "0" : "-1",
            "data-tool-name": tool.name,
          },
          [
            el("span", { class: "att-tool-title" }, [tool.title ?? tool.name]),
            el("span", { class: "att-tool-name" }, [tool.name]),
          ],
        );
        choice.addEventListener("click", () => {
          selectTool(tool.name, true);
        });
        choiceButtons.push(choice);
        list.append(choice);
      }
    };
    search.input.addEventListener("input", () => {
      toolQuery = search.input.value;
      paintTools();
    });
    list.addEventListener("keydown", (event) => {
      const current = choiceButtons.indexOf(event.target as HTMLButtonElement);
      const next = nextRovingIndex(
        current,
        choiceButtons.length,
        event.key,
        "vertical",
      );
      if (next === undefined) return;
      event.preventDefault();
      const tool = visibleTools[next];
      if (tool !== undefined) selectTool(tool.name, true);
    });
    sidebar.append(search.field, list);
    paintTools();

    const selected = tools.find(({ name }) => name === selectedToolName);
    if (selected === undefined) {
      return el("div", { class: "att-tools-layout" }, [
        sidebar,
        el("section", { class: "att-tool-detail" }, [
          el("div", { class: "att-empty" }, [
            "The connected server did not advertise any tools.",
          ]),
        ]),
      ]);
    }

    const schemaText = pretty(selected.inputSchema);
    const schema = el("pre", { class: "att-pre" }, [schemaText]);
    const seed = seedArguments(selected.inputSchema);
    const source = argumentDrafts.get(selected.name) ?? seed;
    const argumentsId = controlId("arguments");
    const argumentsEditor = el("textarea", {
      id: argumentsId,
      class: "att-textarea",
      spellcheck: "false",
      "aria-label": `JSON arguments for ${selected.name}`,
    });
    argumentsEditor.value = source;
    argumentsEditor.addEventListener("input", () => {
      argumentDrafts.set(selected.name, argumentsEditor.value);
    });
    const feedback = el("p", {
      class: "att-feedback",
      role: "alert",
      "aria-live": "assertive",
    });
    const emptyResult = "Invoke this tool to inspect its current result.";
    const hasResult = currentResult?.toolName === selected.name;
    const result = el(
      "pre",
      {
        class: "att-pre att-result",
        role: "status",
        "aria-live": "polite",
        "aria-label": "Current result",
      },
      [hasResult ? pretty(currentResult?.value) : emptyResult],
    );
    const resultState = el("span", {}, [hasResult ? "Returned" : "Not run"]);
    const invoke = el(
      "button",
      { type: "button", class: "att-button primary" },
      ["Invoke"],
    );
    const format = el("button", { type: "button", class: "att-button" }, [
      "Format JSON",
    ]);
    const reset = el("button", { type: "button", class: "att-button" }, [
      "Reset to schema",
    ]);

    const writeDraft = (value: string): void => {
      argumentsEditor.value = value;
      argumentDrafts.set(selected.name, value);
    };
    format.addEventListener("click", () => {
      feedback.textContent = "";
      try {
        writeDraft(pretty(parseToolArguments(argumentsEditor.value)));
      } catch (error) {
        feedback.textContent = errorMessage(error);
        argumentsEditor.focus();
      }
    });
    reset.addEventListener("click", () => {
      feedback.textContent = "";
      writeDraft(seed);
      argumentsEditor.focus();
    });

    const runCall = (): void => {
      if (invoke.disabled) return;
      feedback.textContent = "";
      let argumentsValue: Readonly<Record<string, AttachedJsonValue>>;
      try {
        argumentsValue = parseToolArguments(argumentsEditor.value);
      } catch (error) {
        feedback.textContent = errorMessage(error);
        return;
      }
      invoke.disabled = true;
      invoke.textContent = "Invoking…";
      resultState.textContent = "Waiting";
      result.textContent = "Waiting for the server…";
      const startedAt = performance.now();
      void api
        .callTool(selected.name, argumentsValue)
        .then((value) => {
          currentResult = { toolName: selected.name, value };
          result.textContent = pretty(value);
          resultState.textContent = `Returned · ${formatDuration(performance.now() - startedAt)}`;
        })
        .catch((error: unknown) => {
          feedback.textContent = errorMessage(error);
          result.textContent = "No result was returned.";
          resultState.textContent = `Failed · ${formatDuration(performance.now() - startedAt)}`;
        })
        .finally(() => {
          invoke.disabled = false;
          invoke.textContent = "Invoke";
          activityLoaded = false;
        });
    };
    invoke.addEventListener("click", runCall);
    argumentsEditor.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      runCall();
    });

    const tags = annotationTags(selected.annotations);
    const detail = el(
      "section",
      { id: "attached-tool-detail", class: "att-tool-detail" },
      [
        el("header", { class: "att-tool-header" }, [
          el("h2", {}, [selected.title ?? selected.name]),
          el("span", { class: "att-tool-name" }, [selected.name]),
          ...(tags.length === 0
            ? []
            : [el("div", { class: "att-tool-tags" }, tags)]),
          ...(selected.description === undefined
            ? []
            : [el("p", {}, [selected.description])]),
        ]),
        el("div", { class: "att-tool-grid" }, [
          el("section", { class: "att-pane", "aria-label": "Input schema" }, [
            el("div", { class: "att-pane-bar" }, [
              el("span", {}, ["Input schema"]),
              el("div", { class: "att-pane-tools" }, [
                el("span", {}, ["JSON Schema"]),
                createCopyButton(
                  "input schema",
                  () => schemaText,
                  "att-copy-button",
                ),
              ]),
            ]),
            schema,
          ]),
          el(
            "section",
            { class: "att-pane", "aria-label": "Manual tool call" },
            [
              el("div", { class: "att-pane-bar" }, [
                el("span", {}, ["Manual call"]),
                el("span", {}, ["JSON"]),
              ]),
              el("div", { class: "att-pane-body" }, [
                labelFor("Arguments", argumentsId, "att-label"),
                argumentsEditor,
                el("div", { class: "att-actions" }, [
                  invoke,
                  format,
                  reset,
                  el("span", { class: "att-shortcut" }, [
                    "Ctrl/⌘ + Enter invokes",
                  ]),
                ]),
                feedback,
              ]),
              el("div", { class: "att-pane-bar" }, [
                el("span", {}, ["Current result"]),
                el("div", { class: "att-pane-tools" }, [
                  resultState,
                  createCopyButton(
                    "current result",
                    () => {
                      const text = result.textContent ?? "";
                      return text === emptyResult ? "" : text;
                    },
                    "att-copy-button",
                  ),
                ]),
              ]),
              result,
            ],
          ),
        ]),
      ],
    );
    return el("div", { class: "att-tools-layout" }, [sidebar, detail]);
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
            "Protocol-operation metadata for this connection",
          ]),
        ]),
        el("div", { class: "att-actions att-heading-actions" }, [
          ...(activityLoaded && activity.length > 0
            ? [
                el("span", { class: "att-pill" }, [
                  `${String(activity.length)} ${activity.length === 1 ? "operation" : "operations"}`,
                ]),
              ]
            : []),
          refresh,
        ]),
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
          "No protocol operations have been recorded for this connection.",
        ]),
      );
    } else {
      content.push(activityTable(activity));
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
          tools = [];
          toolsLoaded = false;
          activity = [];
          activityLoaded = false;
          selectedToolName = undefined;
          currentResult = undefined;
          argumentDrafts.clear();
          secretConfigured = false;
          connectionError = "";
          activeTab = "tools";
          stopActivityPolling();
          render();
        })
        .catch((error: unknown) => {
          disconnect.disabled = false;
          disconnect.textContent = "Disconnect";
          feedback.textContent = errorMessage(error);
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
            "Sanitized validation details for the attached server",
          ]),
        ]),
        disconnect,
      ]),
      el("div", { class: "att-summary-grid" }, [
        item("Server", summary.server.name),
        item("Server version", summary.server.version),
        item("Protocol", summary.server.protocolVersion),
        item("Transport", summary.transport === "stdio" ? "stdio" : "HTTP"),
        item("Validation", "Initialization and catalog complete"),
        item("Catalog pages", String(summary.pageCount)),
        item("Tools", String(summary.toolCount)),
      ]),
      el("div", { class: "att-callout" }, [
        secretConfigured
          ? "Sensitive values •••••••• configured in process memory."
          : "Authentication details are never returned to this page.",
      ]),
      feedback,
    ]);
  }

  async function selectTab(name: AttachedTab): Promise<void> {
    activeTab = name;
    if (name === "activity") startActivityPolling();
    else stopActivityPolling();
    render();
    if (name === "activity") {
      // An invoke marks the cache stale, and other clients may add records;
      // entering the tab always re-reads the server instead of showing it.
      await loadActivity();
    }
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

  async function loadTools(): Promise<void> {
    if (toolsLoading) return;
    toolsLoading = true;
    toolsError = "";
    render();
    try {
      tools = await api.tools();
      toolsLoaded = true;
      if (selectedToolName === undefined) selectedToolName = tools[0]?.name;
    } catch (error) {
      toolsError = errorMessage(error);
    } finally {
      toolsLoading = false;
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
      activityError = errorMessage(error);
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
      el("h2", { id: "attached-shortcuts-title" }, ["Keyboard shortcuts"]),
      el("dl", { class: "att-shortcuts-list" }, [
        shortcutEntry("Ctrl/⌘ + Enter", "Invoke the selected tool"),
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
        "aria-labelledby": "attached-shortcuts-title",
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
      oauthFlowActive = targetState.state === "authorizing";
      authorizationPollingPaused = false;
      render();
      if (targetState.state === "authorizing") {
        startAuthorizationPolling();
        root.querySelector<HTMLElement>("[data-att-oauth-heading]")?.focus();
      }
      if (
        targetState.state === "connected" &&
        targetState.connection !== undefined
      ) {
        void loadTools();
      }
    })
    .catch((error: unknown) => {
      targetState = { state: "idle" };
      render();
      const alert = root.querySelector<HTMLElement>(".att-feedback");
      if (alert !== null) alert.textContent = errorMessage(error);
    });

  return {
    destroy() {
      destroyed = true;
      closeShortcuts();
      ownerDocument.body.removeEventListener("keydown", onShortcutKeydown);
      stopAuthorizationPolling();
      stopActivityPolling();
      oauthAuthorizationUrl = undefined;
      oauthFlowActive = false;
      authorizationPollingPaused = false;
      root.replaceChildren();
      ownerDocument.body.classList.remove("attached-mode");
    },
  };
}

if (typeof document !== "undefined") {
  const start = (): void => {
    mountAttachedApp(document.body);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
