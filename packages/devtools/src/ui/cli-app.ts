import { createCopyButton, formatDuration } from "./clipboard.js";
import { clear, el, pretty } from "./dom.js";
import { exampleFromSchema } from "./example-from-schema.js";
import { createCompactThemeToggle, createThemeToggle } from "./theme.js";

export type CliJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CliJsonValue[]
  | { readonly [key: string]: CliJsonValue };

export interface CliTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CliCapabilitySummary {
  readonly id: string;
  readonly description: string;
  readonly title?: string;
  readonly annotations?: Readonly<Record<string, CliJsonValue>>;
}

export interface CliCapabilityDescription extends CliCapabilitySummary {
  readonly inputSchema: Readonly<Record<string, CliJsonValue>>;
  readonly outputSchema: Readonly<Record<string, CliJsonValue>>;
  readonly timeoutMs?: number;
}

export interface CliConnectionSummary {
  readonly command: string;
  readonly capabilityCount: number;
}

export type CliConnectionState =
  | {
      readonly state: "idle";
      readonly validation?: {
        readonly status: "error";
        readonly error: { readonly code: string; readonly message: string };
      };
      readonly activity?: readonly CliActivityRecord[];
    }
  | { readonly state: "busy" | "connecting" | "closing" }
  | {
      readonly state: "connected";
      readonly connection?: CliConnectionSummary;
    };

export type CliSession = CliConnectionState & {
  readonly csrfToken: string;
};

export interface CliActivityRecord {
  readonly sequence: number | string;
  readonly operation: "list" | "describe" | "run" | "disconnect";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: string;
  readonly errorCode?: string;
  readonly capabilityId?: string;
  readonly exitCode?: number | null;
}

export interface CliApi {
  session(): Promise<CliSession>;
  connect(target: CliTarget): Promise<CliConnectionState>;
  disconnect(): Promise<CliConnectionState>;
  refresh(): Promise<CliConnectionState>;
  catalog(): Promise<readonly CliCapabilitySummary[]>;
  describe(id: string): Promise<CliCapabilityDescription>;
  run(id: string, input: CliJsonValue): Promise<CliJsonValue>;
  activity(): Promise<readonly CliActivityRecord[]>;
}

export interface CliTargetDraft {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: readonly Readonly<{
    name: string;
    value: string;
  }>[];
}

export interface SecretControl {
  value: string;
  placeholder?: string;
}

export const cliPrimaryTabs = ["Commands", "Activity", "Connection"] as const;

const activityPollDelayMs = 5_000;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

type CliTab = "commands" | "activity" | "connection";
type Fetcher = typeof fetch;
type RovingOrientation = "horizontal" | "vertical" | "both";
type TargetDraftField = "command" | "environment-name" | "environment-value";

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

function nonEmpty(value: string, message: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new TargetDraftValidationError("command", message);
  }
  return normalized;
}

export function buildCliTarget(draft: CliTargetDraft): CliTarget {
  const command = nonEmpty(draft.command, "Command is required.");
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
    command,
    args: [...draft.args],
    ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
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

export function seedCliInput(
  schema: Readonly<Record<string, CliJsonValue>>,
): string {
  const example = exampleFromSchema(schema);
  if (typeof example !== "object" || example === null || Array.isArray(example))
    return "{}";
  return pretty(example);
}

export function parseRunInput(
  source: string,
): Readonly<Record<string, CliJsonValue>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Run input must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Run input must be a JSON object.");
  }
  return parsed as Readonly<Record<string, CliJsonValue>>;
}

export function retainedActivityOf(
  state: CliConnectionState,
): readonly CliActivityRecord[] {
  if (state.state !== "idle") return [];
  return Array.isArray(state.activity) ? state.activity : [];
}

export class CliApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliApiError";
    this.code = code;
  }
}

/** Refresh is another `list`. Any list failure except busy disconnects. */
export function refreshFailureIsDisconnect(code: string | undefined): boolean {
  return code !== "TARGET_BUSY";
}

async function responseJson<Value>(response: Response): Promise<Value> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CliApiError(
      "PROTOCOL_ERROR",
      "The local interface returned an invalid response.",
    );
  }
  if (!response.ok) {
    const error = value as {
      readonly code?: unknown;
      readonly message?: unknown;
    };
    throw new CliApiError(
      typeof error.code === "string" ? error.code : "CONNECTION_FAILED",
      typeof error.message === "string"
        ? error.message
        : "The local request could not be completed.",
    );
  }
  return value as Value;
}

export function createRouteCliApi(fetcher: Fetcher = fetch): CliApi {
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
      const response = await get<CliSession>("/api/session");
      csrfToken = response.csrfToken;
      return response;
    },
    connect: (target) =>
      mutate<CliConnectionState>("/api/connection", "POST", target),
    disconnect: () => mutate<CliConnectionState>("/api/connection", "DELETE"),
    refresh: () => mutate<CliConnectionState>("/api/refresh", "POST"),
    async catalog() {
      const response = await get<{
        readonly capabilities: readonly CliCapabilitySummary[];
      }>("/api/catalog");
      return response.capabilities;
    },
    describe: (id) =>
      mutate<CliCapabilityDescription>("/api/describe", "POST", { id }),
    async run(id, input) {
      const response = await mutate<{ readonly result: CliJsonValue }>(
        "/api/run",
        "POST",
        { id, input },
      );
      return response.result;
    },
    async activity() {
      const response = await get<{
        readonly records: readonly CliActivityRecord[];
      }>("/api/activity");
      return response.records;
    },
  };
}

function createBrandMark(): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const mark = document.createElementNS(namespace, "svg");
  mark.setAttribute("viewBox", "0 0 51 43");
  mark.setAttribute("width", "24");
  mark.setAttribute("height", "20");
  mark.setAttribute("fill", "none");
  mark.setAttribute("class", "att-brand-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("focusable", "false");
  const strokes = document.createElementNS(namespace, "g");
  strokes.setAttribute("transform", "translate(-6.5,-10.5)");
  strokes.setAttribute("stroke-width", "9");
  strokes.setAttribute("stroke-linecap", "round");
  strokes.setAttribute("stroke-linejoin", "round");
  const prompt = document.createElementNS(namespace, "path");
  prompt.setAttribute("d", "M11 15 L29 32 L11 49");
  prompt.setAttribute("stroke", "var(--att-accent-text)");
  const cursor = document.createElementNS(namespace, "path");
  cursor.setAttribute("d", "M36 49 H53");
  cursor.setAttribute("stroke", "var(--att-fg)");
  strokes.append(prompt, cursor);
  mark.append(strokes);
  return mark;
}

let controlSequence = 0;

function controlId(name: string): string {
  controlSequence += 1;
  return `cli-${name}-${String(controlSequence)}`;
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
  readOnly: "Read-only",
  destructive: "Destructive",
  idempotent: "Idempotent",
  openWorld: "Open world",
};

function annotationTags(
  annotations: Readonly<Record<string, CliJsonValue>> | undefined,
): readonly HTMLElement[] {
  return Object.entries(annotations ?? {})
    .filter(([, value]) => value === true)
    .map(([name]) =>
      el(
        "span",
        {
          class: `att-tag${name === "destructive" ? " danger" : ""}`,
        },
        [annotationLabels[name] ?? name],
      ),
    );
}

function clockReading(instant: string): string {
  const separator = instant.indexOf("T");
  if (separator === -1) return instant;
  return instant.slice(separator + 1).replace("Z", "");
}

function activityTable(records: readonly CliActivityRecord[]): HTMLElement {
  const body = el(
    "tbody",
    {},
    records.map((record) =>
      el("tr", {}, [
        el("td", { class: "att-mono" }, [String(record.sequence)]),
        el("td", {}, [record.operation]),
        el("td", { class: "att-mono" }, [record.capabilityId ?? "—"]),
        el("td", { class: "att-mono att-numeric" }, [
          record.exitCode === undefined || record.exitCode === null
            ? "—"
            : String(record.exitCode),
        ]),
        el(
          "td",
          {
            class: "att-mono att-numeric",
            title: clockReading(record.startedAt),
          },
          [`${String(record.durationMs)} ms`],
        ),
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
        el("th", { scope: "col" }, ["Verb"]),
        el("th", { scope: "col" }, ["Id"]),
        el("th", { scope: "col" }, ["Exit"]),
        el("th", { scope: "col" }, ["Duration"]),
        el("th", { scope: "col" }, ["Outcome"]),
      ]),
    ]),
    body,
  ]);
}

function statusPill(state: CliConnectionState): HTMLElement {
  const label =
    state.state === "connected"
      ? "Connected"
      : state.state === "idle"
        ? "Not connected"
        : state.state === "busy"
          ? "Target busy"
          : state.state === "connecting"
            ? "Connecting"
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

export interface CliAppHandle {
  destroy(): void;
}

export function mountCliApp(
  root: HTMLElement,
  api: CliApi = createRouteCliApi(),
): CliAppHandle {
  type EditablePair = SecretControl & { name: string };
  const ownerDocument = root.ownerDocument;
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
  let targetState: CliConnectionState = { state: "idle" };
  let activeTab: CliTab = "commands";
  let commands: readonly CliCapabilitySummary[] = [];
  let commandsLoaded = false;
  let commandsLoading = false;
  let commandsError = "";
  let selectedId: string | undefined;
  let described: CliCapabilityDescription | undefined;
  let describeError = "";
  let commandQuery = "";
  let activity: readonly CliActivityRecord[] = [];
  let activityLoaded = false;
  let activityLoading = false;
  let activityError = "";
  let activityPoll: ReturnType<typeof setInterval> | undefined;
  let connectionError = "";
  let secretConfigured = false;
  const draft: {
    command: string;
    args: string[];
    cwd: string;
    environment: EditablePair[];
  } = { command: "", args: [], cwd: "", environment: [] };
  const fullThemeToggle = createThemeToggle();
  const compactThemeToggle = createCompactThemeToggle();
  const argumentDrafts = new Map<string, string>();
  let currentResult:
    | { readonly id: string; readonly value: CliJsonValue }
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

  const createTabs = (): HTMLElement => {
    const buttons: HTMLButtonElement[] = [];
    const nav = el(
      "nav",
      {
        class: "att-tabs",
        role: "tablist",
        "aria-label": "CLI workbench sections",
        "aria-orientation": "horizontal",
      },
      cliPrimaryTabs.map((label) => {
        const name = label.toLowerCase() as CliTab;
        const button = el(
          "button",
          {
            type: "button",
            role: "tab",
            id: `cli-tab-${name}`,
            "aria-controls": `cli-panel-${name}`,
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
      const tab = cliPrimaryTabs.at(
        (next + cliPrimaryTabs.length) % cliPrimaryTabs.length,
      );
      if (destination === undefined || tab === undefined) return;
      void selectTab(tab.toLowerCase() as CliTab).then(() => {
        ownerDocument.getElementById(destination.id)?.focus();
      });
    });
    return nav;
  };

  const shell = (content: HTMLElement, includeTabs: boolean): void => {
    const brand = el("div", { class: "att-brand" }, [
      createBrandMark(),
      el("span", { class: "att-brand-name" }, ["invokta"]),
      el("span", { class: "att-product-name" }, ["DevTools"]),
    ]);
    const topbarChildren: Node[] = [brand];
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
        ? targetState.connection.command
        : "CLI workbench";
    const context = el("section", { class: "att-context" }, [
      el("div", { class: "att-frame att-context-inner" }, [
        el("div", { class: "att-context-title" }, [
          el("p", { class: "att-kicker" }, ["CLI workbench"]),
          el("h1", {}, [heading]),
        ]),
        el("div", { class: "att-context-meta" }, [
          statusPill(targetState),
          ...(targetState.state === "connected" &&
          targetState.connection !== undefined
            ? [
                el("span", { class: "att-pill" }, [
                  `${String(targetState.connection.capabilityCount)} commands`,
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
      el("h2", {}, ["Attach one Invokta CLI"]),
      el("p", {}, [
        "Name the executable, arguments, working directory, and environment the operator will type.",
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

      const form = el("form", {}, []);
      const command = textInput({
        label: "Command",
        name: "command",
        value: draft.command,
        placeholder: "node",
        autocomplete: "off",
      });
      command.input.required = true;
      command.input.addEventListener("input", () => {
        draft.command = command.input.value;
      });
      registerValidationField("command", command.input);
      const cwd = textInput({
        label: "Working directory",
        name: "cwd",
        value: draft.cwd,
        placeholder: "Optional directory",
        autocomplete: "off",
      });
      cwd.input.addEventListener("input", () => {
        draft.cwd = cwd.input.value;
      });
      const argumentsHost = el("div", {}, []);
      const addArgumentRows = (
        host: HTMLElement,
        fallbackFocus?: HTMLElement,
        focusIndex?: number,
      ): void => {
        clear(host);
        for (const [index, argument] of draft.args.entries()) {
          const id = controlId("argument");
          const input = el("input", {
            id,
            class: "att-input",
            type: "text",
            "aria-label": `Argument ${String(index + 1)}`,
          });
          input.value = argument;
          input.addEventListener("input", () => {
            draft.args[index] = input.value;
          });
          const remove = el(
            "button",
            {
              type: "button",
              class: "att-button att-icon-button",
              "aria-label": `Remove argument ${String(index + 1)}`,
            },
            ["Remove"],
          );
          remove.addEventListener("click", () => {
            draft.args.splice(index, 1);
            const nextIndex = Math.min(index, draft.args.length - 1);
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
      const addArgument = el(
        "button",
        { type: "button", class: "att-button" },
        ["Add argument"],
      );
      addArgument.addEventListener("click", () => {
        draft.args.push("");
        addArgumentRows(argumentsHost, addArgument, draft.args.length - 1);
      });
      addArgumentRows(argumentsHost, addArgument);

      const environmentHost = el("div", {}, []);
      const addPairRows = (
        host: HTMLElement,
        pairs: EditablePair[],
        fallbackFocus?: HTMLElement,
        focusIndex?: number,
      ): void => {
        clear(host);
        for (const [index, pair] of pairs.entries()) {
          const nameField = textInput({
            label: "Variable name",
            name: "environment-name",
            value: pair.name,
            placeholder: "API_TOKEN",
          });
          const valueField = textInput({
            label: "Variable value",
            name: "environment-value",
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
          registerValidationField("environment-name", nameField.input, index);
          registerValidationField("environment-value", valueField.input, index);
          const remove = el(
            "button",
            {
              type: "button",
              class: "att-button att-icon-button",
              "aria-label": `Remove environment row ${String(index + 1)}`,
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
            .get(validationKey("environment-name", focusIndex))
            ?.focus();
        }
      };
      const addEnvironment = el(
        "button",
        { type: "button", class: "att-button" },
        ["Add environment variable"],
      );
      addEnvironment.addEventListener("click", () => {
        draft.environment.push({ name: "", value: "", placeholder: "" });
        addPairRows(
          environmentHost,
          draft.environment,
          addEnvironment,
          draft.environment.length - 1,
        );
      });
      addPairRows(environmentHost, draft.environment, addEnvironment);

      const connect = el(
        "button",
        { type: "submit", class: "att-button primary" },
        ["Connect"],
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
        el("div", { class: "att-actions" }, [connect]),
        feedback,
      );
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        feedback.textContent = "";
        let target: CliTarget;
        try {
          target = buildCliTarget({
            command: draft.command,
            args: draft.args,
            cwd: draft.cwd,
            environment: draft.environment,
          });
        } catch (error) {
          feedback.textContent = errorMessage(error);
          if (error instanceof TargetDraftValidationError) {
            validationFields
              .get(validationKey(error.field, error.index))
              ?.setAttribute("aria-invalid", "true");
          }
          return;
        }
        const secretControls = [...draft.environment];
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
            secretConfigured = carriesSecrets;
            connectionError = "";
            render();
            if (
              targetState.state === "connected" &&
              targetState.connection !== undefined
            ) {
              void loadCatalog();
            }
          })
          .catch((error: unknown) => {
            connect.disabled = false;
            connect.textContent = "Connect";
            feedback.textContent = errorMessage(error);
          });
      });

      const orientation = el("aside", { class: "att-idle-orient" }, [
        el("h3", {}, ["This is the CLI workbench."]),
        el("p", {}, [
          "It inspects an installed Invokta CLI without loading an engine.",
        ]),
        el("dl", { class: "att-idle-orient-paths" }, [
          el("dt", {}, ["MCP workbench"]),
          el("dd", {}, [
            el("div", { class: "att-mono" }, ["invokta-devtools"]),
            el("div", {}, ["or invokta-devtools open"]),
          ]),
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
                  "CLI verbs retained from the disconnected target",
                ]),
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
      ]),
      false,
    );
  }

  function renderConnected(): void {
    let panel: HTMLElement;
    if (activeTab === "activity") panel = renderActivityPanel();
    else if (activeTab === "connection") panel = renderConnectionPanel();
    else panel = renderCommandsPanel();
    panel.id = `cli-panel-${activeTab}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", `cli-tab-${activeTab}`);
    panel.setAttribute("tabindex", "0");
    shell(el("div", { class: "att-card att-workbench" }, [panel]), true);
  }

  function filterCommands(
    items: readonly CliCapabilitySummary[],
    query: string,
  ): readonly CliCapabilitySummary[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") return items;
    return items.filter((item) =>
      [item.id, item.title ?? "", item.description].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }

  function renderCommandsPanel(): HTMLElement {
    if (commandsLoading && !commandsLoaded) {
      return el("section", { class: "att-loading" }, ["Loading commands…"]);
    }
    if (commandsError !== "" && !commandsLoaded) {
      const retry = el("button", { type: "button", class: "att-button" }, [
        "Refresh catalog",
      ]);
      retry.addEventListener("click", () => void loadCatalog());
      return el("section", { class: "att-view" }, [
        el("h2", {}, ["Commands unavailable"]),
        el("p", { class: "att-feedback", role: "alert" }, [commandsError]),
        retry,
      ]);
    }

    if (
      selectedId === undefined ||
      !commands.some(({ id }) => id === selectedId)
    ) {
      selectedId = commands[0]?.id;
    }
    const sidebar = el("aside", { class: "att-tool-sidebar" }, [
      el("h2", {}, ["Commands"]),
      el("p", { class: "att-hint" }, [
        `${String(commands.length)} advertised commands`,
      ]),
    ]);
    const search = textInput({
      label: "Search commands",
      name: "command-search",
      value: commandQuery,
      placeholder: "Id, title, or description",
      type: "search",
      autocomplete: "off",
    });
    const list = el(
      "div",
      {
        class: "att-tool-list",
        role: "listbox",
        "aria-label": "Connected CLI commands",
      },
      [],
    );
    let visible: readonly CliCapabilitySummary[] = [];
    let choiceButtons: HTMLButtonElement[] = [];
    const focusChoice = (id: string): void => {
      Array.from(root.querySelectorAll<HTMLButtonElement>(".att-tool-choice"))
        .find((candidate) => candidate.dataset.commandId === id)
        ?.focus();
    };
    const selectCommand = (id: string, focus: boolean): void => {
      selectedId = id;
      described = undefined;
      describeError = "";
      render();
      void loadDescribe(id);
      if (focus) focusChoice(id);
    };
    const paintCommands = (): void => {
      clear(list);
      const matches = filterCommands(commands, search.input.value);
      visible = matches;
      choiceButtons = [];
      if (matches.length === 0) {
        list.append(el("p", { class: "att-empty" }, ["No matching commands."]));
        return;
      }
      const rovingId = matches.some(({ id }) => id === selectedId)
        ? selectedId
        : matches[0]?.id;
      for (const item of matches) {
        const choice = el(
          "button",
          {
            type: "button",
            class: "att-tool-choice",
            role: "option",
            "aria-selected": String(item.id === selectedId),
            tabindex: item.id === rovingId ? "0" : "-1",
            "data-command-id": item.id,
          },
          [
            el("span", { class: "att-tool-title" }, [item.title ?? item.id]),
            el("span", { class: "att-tool-name" }, [item.id]),
          ],
        );
        choice.addEventListener("click", () => {
          selectCommand(item.id, true);
        });
        choiceButtons.push(choice);
        list.append(choice);
      }
    };
    search.input.addEventListener("input", () => {
      commandQuery = search.input.value;
      paintCommands();
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
      const item = visible[next];
      if (item !== undefined) selectCommand(item.id, true);
    });
    sidebar.append(search.field, list);
    paintCommands();

    const selected = commands.find(({ id }) => id === selectedId);
    if (selected === undefined) {
      return el("div", { class: "att-tools-layout" }, [
        sidebar,
        el("section", { class: "att-tool-detail" }, [
          el("div", { class: "att-empty" }, [
            "The connected CLI did not advertise any commands.",
          ]),
        ]),
      ]);
    }

    const contractCopy = el("p", { class: "att-hint" }, [
      "This CLI uses its own composition root. DevTools does not supply a principal. Each verb starts a new process and the process exits.",
    ]);

    if (described === undefined || described.id !== selected.id) {
      return el("div", { class: "att-tools-layout" }, [
        sidebar,
        el("section", { class: "att-tool-detail" }, [
          el("header", { class: "att-tool-header" }, [
            el("h2", {}, [selected.title ?? selected.id]),
            el("span", { class: "att-tool-name" }, [selected.id]),
          ]),
          contractCopy,
          describeError === ""
            ? el("p", { class: "att-hint" }, ["Reading the describe contract…"])
            : el("p", { class: "att-feedback", role: "alert" }, [
                describeError,
              ]),
        ]),
      ]);
    }

    const selectedDescription = described;
    const schemaText = pretty(selectedDescription.inputSchema);
    const schema = el("pre", { class: "att-pre" }, [schemaText]);
    const seed = seedCliInput(selectedDescription.inputSchema);
    const source = argumentDrafts.get(selectedDescription.id) ?? seed;
    const argumentsId = controlId("arguments");
    const argumentsEditor = el("textarea", {
      id: argumentsId,
      class: "att-textarea",
      spellcheck: "false",
      "aria-label": `JSON input for ${selectedDescription.id}`,
    });
    argumentsEditor.value = source;
    argumentsEditor.addEventListener("input", () => {
      argumentDrafts.set(selectedDescription.id, argumentsEditor.value);
    });
    const feedback = el("p", {
      class: "att-feedback",
      role: "alert",
      "aria-live": "assertive",
    });
    const emptyResult = "Run this command to inspect its current result.";
    const hasResult = currentResult?.id === selectedDescription.id;
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
    const run = el("button", { type: "button", class: "att-button primary" }, [
      "Run",
    ]);
    const format = el("button", { type: "button", class: "att-button" }, [
      "Format JSON",
    ]);
    const reset = el("button", { type: "button", class: "att-button" }, [
      "Reset to schema",
    ]);
    const writeDraft = (value: string): void => {
      argumentsEditor.value = value;
      argumentDrafts.set(selectedDescription.id, value);
    };
    format.addEventListener("click", () => {
      feedback.textContent = "";
      try {
        writeDraft(pretty(parseRunInput(argumentsEditor.value)));
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
      if (run.disabled) return;
      feedback.textContent = "";
      let input: Readonly<Record<string, CliJsonValue>>;
      try {
        input = parseRunInput(argumentsEditor.value);
      } catch (error) {
        feedback.textContent = errorMessage(error);
        return;
      }
      run.disabled = true;
      run.textContent = "Running…";
      resultState.textContent = "Waiting";
      result.textContent = "Waiting for the CLI…";
      const startedAt = performance.now();
      void api
        .run(selectedDescription.id, input)
        .then((value) => {
          currentResult = { id: selectedDescription.id, value };
          result.textContent = pretty(value);
          resultState.textContent = `Returned · ${formatDuration(performance.now() - startedAt)}`;
        })
        .catch((error: unknown) => {
          feedback.textContent = errorMessage(error);
          result.textContent = "No result was returned.";
          resultState.textContent = `Failed · ${formatDuration(performance.now() - startedAt)}`;
        })
        .finally(() => {
          run.disabled = false;
          run.textContent = "Run";
          activityLoaded = false;
        });
    };
    run.addEventListener("click", runCall);
    argumentsEditor.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      runCall();
    });

    const tags = annotationTags(selectedDescription.annotations);
    const detail = el(
      "section",
      { id: "cli-command-detail", class: "att-tool-detail" },
      [
        el("header", { class: "att-tool-header" }, [
          el("h2", {}, [selectedDescription.title ?? selectedDescription.id]),
          el("span", { class: "att-tool-name" }, [selectedDescription.id]),
          ...(tags.length === 0
            ? []
            : [el("div", { class: "att-tool-tags" }, tags)]),
          el("p", {}, [selectedDescription.description]),
        ]),
        contractCopy,
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
          el("section", { class: "att-pane", "aria-label": "Manual run" }, [
            el("div", { class: "att-pane-bar" }, [
              el("span", {}, ["Run"]),
              el("span", {}, ["JSON"]),
            ]),
            el("div", { class: "att-pane-body" }, [
              labelFor("Input", argumentsId, "att-label"),
              argumentsEditor,
              el("div", { class: "att-actions" }, [
                run,
                format,
                reset,
                el("span", { class: "att-shortcut" }, ["Ctrl/⌘ + Enter"]),
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
          ]),
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
            "Verb, id, exit, duration, and outcome only",
          ]),
        ]),
        refresh,
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
          "No CLI verbs have been recorded for this connection.",
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
    const refresh = el("button", { type: "button", class: "att-button" }, [
      "Refresh catalog",
    ]);
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
          commands = [];
          commandsLoaded = false;
          activity = [];
          activityLoaded = false;
          selectedId = undefined;
          described = undefined;
          currentResult = undefined;
          argumentDrafts.clear();
          secretConfigured = false;
          connectionError = "";
          activeTab = "commands";
          stopActivityPolling();
          render();
        })
        .catch((error: unknown) => {
          disconnect.disabled = false;
          disconnect.textContent = "Disconnect";
          feedback.textContent = errorMessage(error);
        });
    });
    refresh.addEventListener("click", () => {
      refresh.disabled = true;
      void api
        .refresh()
        .then((state) => {
          targetState = state;
          described = undefined;
          selectedId = undefined;
          currentResult = undefined;
          argumentDrafts.clear();
          connectionError = "";
          void loadCatalog();
        })
        .catch((error: unknown) => {
          const code = error instanceof CliApiError ? error.code : undefined;
          const message = errorMessage(error);
          if (!refreshFailureIsDisconnect(code)) {
            feedback.textContent = message;
            return;
          }
          connectionError = message;
          targetState = {
            state: "idle",
            validation: {
              status: "error",
              error: {
                code: code ?? "CONNECTION_FAILED",
                message,
              },
            },
          };
          commands = [];
          commandsLoaded = false;
          described = undefined;
          currentResult = undefined;
          selectedId = undefined;
          argumentDrafts.clear();
          stopActivityPolling();
          render();
        })
        .finally(() => {
          refresh.disabled = false;
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
            "Sanitized validation details for the attached CLI",
          ]),
        ]),
        el("div", { class: "att-actions" }, [refresh, disconnect]),
      ]),
      el("div", { class: "att-summary-grid" }, [
        item("Command", summary.command),
        item("Validation", "list complete"),
        item("Commands", String(summary.capabilityCount)),
      ]),
      el("div", { class: "att-callout" }, [
        secretConfigured
          ? "Sensitive values •••••••• configured in process memory."
          : "Environment values are never returned to this page.",
      ]),
      feedback,
    ]);
  }

  async function selectTab(name: CliTab): Promise<void> {
    activeTab = name;
    if (name === "activity") startActivityPolling();
    else stopActivityPolling();
    render();
    if (name === "activity") {
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

  async function loadCatalog(): Promise<void> {
    if (commandsLoading) return;
    commandsLoading = true;
    commandsError = "";
    render();
    try {
      commands = await api.catalog();
      commandsLoaded = true;
      if (selectedId === undefined) selectedId = commands[0]?.id;
      if (selectedId !== undefined) void loadDescribe(selectedId);
    } catch (error) {
      commandsError = errorMessage(error);
    } finally {
      commandsLoading = false;
      render();
    }
  }

  async function loadDescribe(id: string): Promise<void> {
    describeError = "";
    try {
      described = await api.describe(id);
    } catch (error) {
      described = undefined;
      describeError = errorMessage(error);
    } finally {
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
      el("h2", { id: "cli-shortcuts-title" }, ["Keyboard shortcuts"]),
      el("dl", { class: "att-shortcuts-list" }, [
        shortcutEntry("Ctrl/⌘ + Enter", "Run the selected command"),
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
        "aria-labelledby": "cli-shortcuts-title",
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
      render();
      if (
        targetState.state === "connected" &&
        targetState.connection !== undefined
      ) {
        void loadCatalog();
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
      stopActivityPolling();
      root.replaceChildren();
      ownerDocument.body.classList.remove("attached-mode");
    },
  };
}

if (typeof document !== "undefined") {
  const start = (): void => {
    mountCliApp(document.body);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
