import { type CapabilityInfo, callTool, toolCallRequest } from "./api.js";
import { createCopyButton, formatDuration } from "./clipboard.js";
import { el, pretty } from "./dom.js";
import { exampleFromSchema } from "./example-from-schema.js";
import { parseMcpResponse } from "./mcp-response.js";
import { prefillKeyFor } from "./playground-handoff.js";
import { getActiveToken } from "./principals.js";

const emptyResult = "Invoke the capability to see its result.";

const timeoutSlackMs = 2_000;
const defaultTimeoutMs = 28_000;
const elapsedTickMs = 100;

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Session storage is a convenience; the editor still works in-memory.
  }
}

function dropSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Session storage is a convenience only.
  }
}

/**
 * The newest editor for each capability, keyed by id. One module-level
 * listener serves all of them, so the number of registrations never grows
 * with the catalog size or with how often a panel is rebuilt.
 */
const handoffTargets = new Map<string, (staged: string) => void>();
let handoffListenerAttached = false;

function ensureHandoffListener(): void {
  if (handoffListenerAttached) return;
  if (typeof document.addEventListener !== "function") return;
  handoffListenerAttached = true;
  document.addEventListener("invokta:select-capability", (event) => {
    const id = (event as CustomEvent<{ readonly id?: unknown }>).detail?.id;
    if (typeof id !== "string") return;
    const apply = handoffTargets.get(id);
    if (apply === undefined) return;
    const staged = readSession(prefillKeyFor(id));
    if (staged === null) return;
    dropSession(prefillKeyFor(id));
    apply(staged);
  });
}

/** The shell variable a copied curl command reads the session token from. */
const tokenVariableName = "INVOKTA_DEV_TOKEN";

/**
 * Wraps a value as a POSIX single-quoted shell word. Everything inside single
 * quotes is literal, so only the closing quote itself needs escaping — which
 * keeps apostrophes inside JSON arguments from breaking the command.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type SchemaRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): SchemaRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as SchemaRecord;
}

function schemaTypeOf(schema: SchemaRecord): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type) && typeof type[0] === "string") return type[0];
  return undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

const typeLabels: Readonly<Record<string, string>> = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
  null: "null",
};

function fieldIssue(
  name: string,
  value: unknown,
  schema: unknown,
): string | undefined {
  const record = asRecord(schema);
  if (record === undefined) return undefined;
  const type = schemaTypeOf(record);
  if (type !== undefined && !matchesType(type, value)) {
    return `"${name}" must be ${typeLabels[type] ?? `of type ${type}`}.`;
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    const allowed = record.enum.some(
      (candidate) => pretty(candidate) === pretty(value),
    );
    if (!allowed) return `"${name}" must be one of the allowed values.`;
  }
  return undefined;
}

/** Surfaces the SyntaxError position info instead of a bare "invalid JSON". */
function syntaxDetail(error: unknown): string {
  return error instanceof SyntaxError && error.message !== ""
    ? ` ${error.message}`
    : "";
}

/**
 * Light client-side check of the top-level fields so obvious mistakes are
 * caught before the round trip. Only required properties, primitive types,
 * and enum membership are checked; engine validation stays authoritative.
 */
export function validateArguments(
  args: unknown,
  schema: unknown,
): string | undefined {
  const record = asRecord(schema);
  if (record === undefined) return undefined;
  const type = schemaTypeOf(record);
  const isObjectSchema =
    type === "object" ||
    (type === undefined && record.properties !== undefined);
  if (!isObjectSchema) return undefined;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "Arguments must be a JSON object.";
  }
  const fields = args as Record<string, unknown>;
  if (Array.isArray(record.required)) {
    for (const name of record.required) {
      if (typeof name === "string" && !(name in fields)) {
        return `"${name}" is required.`;
      }
    }
  }
  const properties = asRecord(record.properties);
  if (properties === undefined) return undefined;
  for (const [name, property] of Object.entries(properties)) {
    if (!(name in fields)) continue;
    const issue = fieldIssue(name, fields[name], property);
    if (issue !== undefined) return issue;
  }
  return undefined;
}

/**
 * The invocation playground for one capability: a schema-seeded JSON editor,
 * the invoke action, and the raw MCP request and response of each attempt —
 * exactly what any MCP client would exchange with the engine.
 */
export function renderInvokePanel(capability: CapabilityInfo): HTMLElement {
  const safeId = capability.id.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  const editorId = `input-${safeId}`;
  const feedbackId = `input-feedback-${safeId}`;
  const draftKey = `invokta-devtools:draft:${capability.id}`;
  const prefillKey = prefillKeyFor(capability.id);
  // A prefill handoff (for example "Open in Playground" from Activity) wins
  // over the persisted draft, and both win over the schema-seeded example.
  const prefill = readSession(prefillKey);
  if (prefill !== null) dropSession(prefillKey);
  const seed =
    prefill ??
    readSession(draftKey) ??
    pretty(exampleFromSchema(capability.inputSchema));
  const editor = el(
    "textarea",
    {
      id: editorId,
      rows: "6",
      class: "editor",
      spellcheck: "false",
      "aria-describedby": feedbackId,
      "aria-invalid": "false",
    },
    [seed],
  );
  const feedback = el(
    "p",
    {
      id: feedbackId,
      class: "feedback",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    [],
  );
  const resultView = el(
    "pre",
    {
      class: "result",
      role: "status",
      "aria-label": "Capability result",
      "aria-live": "polite",
      "aria-atomic": "true",
      "aria-busy": "false",
    },
    [emptyResult],
  );
  const resultState = el("span", {}, ["Result · not run"]);

  const windowBar = (
    label: string | HTMLElement,
    ...actions: readonly HTMLElement[]
  ): HTMLElement =>
    el("div", { class: "code-window-bar" }, [
      typeof label === "string" ? el("span", {}, [label]) : label,
      actions.length === 0
        ? null
        : el("span", { class: "code-window-actions" }, actions),
    ]);

  const rawRequest = el(
    "pre",
    { class: "raw", "aria-label": "Raw MCP request body" },
    [],
  );
  const rawResponse = el(
    "pre",
    { class: "raw", "aria-label": "Raw MCP response body" },
    [],
  );
  // The status lives outside the <pre> so copying the response yields the
  // pure, still-parsable body.
  const rawResponseStatus = el("span", { class: "raw-response-status" }, []);
  const rawHeading = (
    heading: string | HTMLElement,
    copyLabel: string,
    read: () => string,
  ): HTMLElement =>
    el("div", { class: "raw-heading" }, [
      typeof heading === "string" ? el("h4", {}, [heading]) : heading,
      createCopyButton(copyLabel, read),
    ]);
  const rawSection = el("details", {}, [
    el("summary", {}, ["Raw MCP exchange"]),
    rawHeading(
      "Request · POST /mcp",
      "raw MCP request",
      () => rawRequest.textContent ?? "",
    ),
    rawRequest,
    rawHeading(
      el("h4", {}, ["Response", rawResponseStatus]),
      "raw MCP response",
      () => rawResponse.textContent ?? "",
    ),
    rawResponse,
  ]);
  rawSection.hidden = true;

  const showResult = (
    state: string,
    content: string,
    isError = false,
    durationMs?: number,
  ): void => {
    const elapsed =
      durationMs === undefined ? "" : ` · ${formatDuration(durationMs)}`;
    resultState.textContent = `Result · ${state}${elapsed}`;
    resultView.textContent = content;
    resultView.classList.toggle("error", isError);
  };

  const reset = el("button", { type: "button" }, ["Reset example"]);
  const format = el("button", { type: "button" }, ["Format JSON"]);
  const invoke = el(
    "button",
    {
      type: "button",
      class: "primary",
      "aria-disabled": "false",
      title: "Invoke capability (Ctrl/Cmd + Enter)",
    },
    ["Invoke capability"],
  );
  const cancel = el("button", { type: "button", class: "invoke-cancel" }, [
    "Cancel",
  ]);
  cancel.hidden = true;
  let pending = false;
  let activeController: AbortController | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let elapsedHandle: ReturnType<typeof setInterval> | undefined;
  let cancelledByUser = false;
  let timedOut = false;
  const clientTimeoutMs =
    (capability.timeoutMs ?? defaultTimeoutMs) + timeoutSlackMs;

  const resetOutput = (): void => {
    feedback.textContent = "";
    showResult("not run", emptyResult);
    rawRequest.textContent = "";
    rawResponse.textContent = "";
    rawResponseStatus.textContent = "";
    rawSection.hidden = true;
  };

  reset.addEventListener("click", () => {
    dropSession(draftKey);
    editor.value = pretty(exampleFromSchema(capability.inputSchema));
    editor.setAttribute("aria-invalid", "false");
    resetOutput();
  });

  format.addEventListener("click", () => {
    feedback.textContent = "";
    editor.setAttribute("aria-invalid", "false");
    try {
      editor.value = pretty(JSON.parse(editor.value) as unknown);
      writeSession(draftKey, editor.value);
    } catch (error) {
      editor.setAttribute("aria-invalid", "true");
      feedback.textContent = `Enter valid JSON before formatting.${syntaxDetail(error)}`;
      editor.focus();
    }
  });

  editor.addEventListener("input", () => {
    writeSession(draftKey, editor.value);
    if (editor.getAttribute("aria-invalid") === "true") {
      editor.setAttribute("aria-invalid", "false");
      feedback.textContent = "";
    }
  });

  // The panel is built once per capability and then reused, so a later
  // handoff (Activity or Diagnostics "Open in Playground") has to be applied
  // here rather than only at construction.
  ensureHandoffListener();
  handoffTargets.set(capability.id, (staged) => {
    editor.value = staged;
    writeSession(draftKey, staged);
    editor.setAttribute("aria-invalid", "false");
    resetOutput();
  });

  const setPending = (next: boolean): void => {
    pending = next;
    invoke.setAttribute("aria-disabled", String(next));
    cancel.hidden = !next;
    reset.disabled = next;
    format.disabled = next;
    invoke.textContent = next ? "Invoking…" : "Invoke capability";
    resultView.setAttribute("aria-busy", String(next));
  };

  cancel.addEventListener("click", () => {
    if (!pending) return;
    cancelledByUser = true;
    activeController?.abort();
  });

  const runInvocation = (): void => {
    if (pending) return;
    feedback.textContent = "";
    editor.setAttribute("aria-invalid", "false");
    rawRequest.textContent = "";
    rawResponse.textContent = "";
    rawResponseStatus.textContent = "";
    rawSection.hidden = true;
    let args: unknown;
    try {
      args = JSON.parse(editor.value);
    } catch (error) {
      editor.setAttribute("aria-invalid", "true");
      feedback.textContent = `Enter valid JSON before invoking.${syntaxDetail(error)}`;
      showResult("not run", "The capability was not invoked.", true);
      editor.focus();
      return;
    }
    const issue = validateArguments(args, capability.inputSchema);
    if (issue !== undefined) {
      editor.setAttribute("aria-invalid", "true");
      feedback.textContent = issue;
      showResult("not run", "The capability was not invoked.", true);
      editor.focus();
      return;
    }
    setPending(true);
    showResult("running", `Running ${capability.id}…`);
    const startedAt = performance.now();
    cancelledByUser = false;
    timedOut = false;
    const controller = new AbortController();
    activeController = controller;
    elapsedHandle = setInterval(() => {
      resultState.textContent = `Result · running · ${formatDuration(performance.now() - startedAt)}`;
    }, elapsedTickMs);
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, clientTimeoutMs);
    void callTool(
      capability.mcpToolName,
      args,
      getActiveToken(),
      controller.signal,
    )
      .then((exchange) => {
        const elapsedMs = performance.now() - startedAt;
        rawSection.hidden = false;
        rawRequest.textContent = exchange.requestBody;
        rawResponseStatus.textContent = ` · HTTP ${String(exchange.status)}`;
        rawResponse.textContent = exchange.responseBody;
        if (exchange.status === 401) {
          feedback.textContent =
            "Authentication failed (HTTP 401). In Test identities, select an identity with a session token, then try again.";
          showResult(
            "HTTP 401",
            exchange.responseBody || "The MCP endpoint returned no body.",
            true,
            elapsedMs,
          );
          return;
        }
        if (exchange.status < 200 || exchange.status >= 300) {
          feedback.textContent = `MCP request failed (HTTP ${String(exchange.status)}). Expand “Raw MCP exchange” for details.`;
          showResult(
            `HTTP ${String(exchange.status)}`,
            exchange.responseBody || "The MCP endpoint returned no body.",
            true,
            elapsedMs,
          );
          return;
        }
        const parsed = parseMcpResponse(
          exchange.contentType,
          exchange.responseBody,
        );
        const message = parsed.message as
          | {
              readonly result?: {
                readonly isError?: boolean;
                readonly structuredContent?: unknown;
                readonly content?: ReadonlyArray<{ readonly text?: string }>;
              };
              readonly error?: unknown;
            }
          | undefined;
        const result = message?.result;
        if (result === undefined) {
          if (message?.error !== undefined) {
            feedback.textContent =
              "MCP returned a protocol error. Expand “Raw MCP exchange” for details.";
            showResult(
              "protocol error",
              pretty(message.error),
              true,
              elapsedMs,
            );
            return;
          }
          feedback.textContent =
            "Couldn’t parse the MCP response. Expand “Raw MCP exchange” for details.";
          showResult(
            "unreadable",
            exchange.responseBody || "The MCP endpoint returned no body.",
            true,
            elapsedMs,
          );
          return;
        }
        if (result.isError === true) {
          feedback.textContent = "The capability returned an engine error.";
          showResult(
            "engine error",
            pretty(
              ((): unknown => {
                const text = result.content?.[0]?.text;
                if (typeof text !== "string") return result;
                try {
                  return JSON.parse(text);
                } catch {
                  return text;
                }
              })(),
            ),
            true,
            elapsedMs,
          );
          return;
        }
        let output = result.structuredContent;
        if (output === undefined) {
          const text = result.content?.[0]?.text;
          if (typeof text === "string") {
            try {
              output = JSON.parse(text);
            } catch {
              output = text;
            }
          } else {
            output = result;
          }
        }
        showResult("success", pretty(output), false, elapsedMs);
      })
      .catch(() => {
        const elapsedMs = performance.now() - startedAt;
        if (cancelledByUser) {
          feedback.textContent = "Invocation cancelled.";
          showResult(
            "cancelled",
            "The invocation was cancelled before a response arrived.",
            true,
            elapsedMs,
          );
          return;
        }
        if (timedOut) {
          const seconds = Math.max(1, Math.round(clientTimeoutMs / 1_000));
          feedback.textContent = `No response within ${String(seconds)} s — the capability may be stuck.`;
          showResult(
            "timeout",
            "No response received before the client timeout.",
            true,
            elapsedMs,
          );
          return;
        }
        feedback.textContent =
          "Couldn’t reach the MCP endpoint. Check that the dev server is running, then try again.";
        showResult("no response", "No response received.", true, elapsedMs);
      })
      .finally(() => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if (elapsedHandle !== undefined) clearInterval(elapsedHandle);
        timeoutHandle = undefined;
        elapsedHandle = undefined;
        activeController = undefined;
        setPending(false);
      });
  };

  invoke.addEventListener("click", runInvocation);
  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    runInvocation();
  });

  const readCurlCommand = (): string => {
    let args: unknown;
    try {
      args = JSON.parse(editor.value);
    } catch {
      return "";
    }
    // The session token is never copied: the command references an
    // environment variable so the clipboard never carries a live credential.
    const request = toolCallRequest(capability.mcpToolName, args, null);
    const origin = (globalThis as { location?: { origin?: unknown } }).location
      ?.origin;
    const target = `${typeof origin === "string" ? origin : ""}${request.path}`;
    const lines = [`curl -X ${request.method} ${shellQuote(target)}`];
    for (const [name, value] of Object.entries(request.headers)) {
      lines.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
    }
    if (getActiveToken() !== null) {
      // Deliberately double-quoted so the shell expands the variable.
      lines.push(`  -H "authorization: Bearer $${tokenVariableName}"`);
    }
    lines.push(`  -d ${shellQuote(request.body)}`);
    return lines.join(" \\\n");
  };

  const requestPane = el("section", { class: "invoke-request" }, [
    el("label", { for: editorId, class: "field-label" }, ["Arguments (JSON)"]),
    el("div", { class: "code-window" }, [
      windowBar(
        "tools/call arguments",
        createCopyButton("arguments", () => editor.value),
        createCopyButton(
          `curl command (reads the token from $${tokenVariableName})`,
          readCurlCommand,
        ),
      ),
      editor,
    ]),
    el("div", { class: "invoke-actions" }, [
      invoke,
      cancel,
      format,
      reset,
      el("span", { class: "shortcut-hint" }, [
        el("kbd", {}, ["Ctrl"]),
        "/",
        el("kbd", {}, ["⌘"]),
        " + ",
        el("kbd", {}, ["Enter"]),
        " invokes from the editor",
      ]),
    ]),
    feedback,
  ]);
  const resultPane = el("section", { class: "invoke-result" }, [
    el("h4", { class: "field-label" }, ["Capability result"]),
    el("div", { class: "code-window result-window" }, [
      windowBar(
        resultState,
        createCopyButton("capability result", () => {
          const text = resultView.textContent ?? "";
          return text === emptyResult ? "" : text;
        }),
      ),
      resultView,
    ]),
  ]);

  return el("div", { class: "invoke-panel" }, [
    el("div", { class: "invoke-heading" }, [
      el("h3", {}, ["Invoke"]),
      el("code", { class: "invoke-route" }, ["tools/call → engine.invoke"]),
    ]),
    el("div", { class: "invoke-workspace" }, [requestPane, resultPane]),
    rawSection,
  ]);
}
