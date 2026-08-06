import { type CapabilityInfo, callTool } from "./api.js";
import { el, pretty } from "./dom.js";
import { exampleFromSchema } from "./example-from-schema.js";
import { parseMcpResponse } from "./mcp-response.js";
import { getActiveToken } from "./principals.js";

const emptyResult = "Invoke the capability to see its result.";

/**
 * The invocation playground for one capability: a schema-seeded JSON editor,
 * the invoke action, and the raw MCP request and response of each attempt —
 * exactly what any MCP client would exchange with the engine.
 */
export function renderInvokePanel(capability: CapabilityInfo): HTMLElement {
  const safeId = capability.id.replaceAll(/[^A-Za-z0-9_-]/g, "-");
  const editorId = `input-${safeId}`;
  const feedbackId = `input-feedback-${safeId}`;
  const editor = el(
    "textarea",
    {
      id: editorId,
      rows: "8",
      class: "editor",
      spellcheck: "false",
      "aria-describedby": feedbackId,
      "aria-invalid": "false",
    },
    [pretty(exampleFromSchema(capability.inputSchema))],
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

  const windowBar = (label: string | HTMLElement): HTMLElement =>
    el("div", { class: "code-window-bar" }, [
      typeof label === "string" ? el("span", {}, [label]) : label,
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
  const rawSection = el("details", {}, [
    el("summary", {}, ["Raw MCP exchange"]),
    el("h4", {}, ["Request · POST /mcp"]),
    rawRequest,
    el("h4", {}, ["Response"]),
    rawResponse,
  ]);
  rawSection.hidden = true;

  const showResult = (
    state: string,
    content: string,
    isError = false,
  ): void => {
    resultState.textContent = `Result · ${state}`;
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
  let pending = false;

  const resetOutput = (): void => {
    feedback.textContent = "";
    showResult("not run", emptyResult);
    rawRequest.textContent = "";
    rawResponse.textContent = "";
    rawSection.hidden = true;
  };

  reset.addEventListener("click", () => {
    editor.value = pretty(exampleFromSchema(capability.inputSchema));
    editor.setAttribute("aria-invalid", "false");
    resetOutput();
  });

  format.addEventListener("click", () => {
    feedback.textContent = "";
    editor.setAttribute("aria-invalid", "false");
    try {
      editor.value = pretty(JSON.parse(editor.value) as unknown);
    } catch {
      editor.setAttribute("aria-invalid", "true");
      feedback.textContent = "Enter valid JSON before formatting.";
      editor.focus();
    }
  });

  editor.addEventListener("input", () => {
    if (editor.getAttribute("aria-invalid") === "true") {
      editor.setAttribute("aria-invalid", "false");
      feedback.textContent = "";
    }
  });

  const setPending = (next: boolean): void => {
    pending = next;
    invoke.setAttribute("aria-disabled", String(next));
    reset.disabled = next;
    format.disabled = next;
    invoke.textContent = next ? "Invoking…" : "Invoke capability";
    resultView.setAttribute("aria-busy", String(next));
  };

  const runInvocation = (): void => {
    if (pending) return;
    feedback.textContent = "";
    editor.setAttribute("aria-invalid", "false");
    rawRequest.textContent = "";
    rawResponse.textContent = "";
    rawSection.hidden = true;
    let args: unknown;
    try {
      args = JSON.parse(editor.value);
    } catch {
      editor.setAttribute("aria-invalid", "true");
      feedback.textContent = "Enter valid JSON before invoking.";
      showResult("not run", "The capability was not invoked.", true);
      editor.focus();
      return;
    }
    setPending(true);
    showResult("running", `Running ${capability.id}…`);
    void callTool(capability.id, args, getActiveToken())
      .then((exchange) => {
        rawSection.hidden = false;
        rawRequest.textContent = exchange.requestBody;
        rawResponse.textContent = `HTTP ${String(exchange.status)}\n${exchange.responseBody}`;
        if (exchange.status === 401) {
          feedback.textContent =
            "Authentication failed (HTTP 401). In Test identities, select an identity with a session token, then try again.";
          showResult(
            "HTTP 401",
            exchange.responseBody || "The MCP endpoint returned no body.",
            true,
          );
          return;
        }
        if (exchange.status < 200 || exchange.status >= 300) {
          feedback.textContent = `MCP request failed (HTTP ${String(exchange.status)}). Expand “Raw MCP exchange” for details.`;
          showResult(
            `HTTP ${String(exchange.status)}`,
            exchange.responseBody || "The MCP endpoint returned no body.",
            true,
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
            showResult("protocol error", pretty(message.error), true);
            return;
          }
          feedback.textContent =
            "Couldn’t parse the MCP response. Expand “Raw MCP exchange” for details.";
          showResult(
            "unreadable",
            exchange.responseBody || "The MCP endpoint returned no body.",
            true,
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
        showResult("success", pretty(output));
      })
      .catch(() => {
        feedback.textContent =
          "Couldn’t reach the MCP endpoint. Check that the dev server is running, then try again.";
        showResult("no response", "No response received.", true);
      })
      .finally(() => {
        setPending(false);
      });
  };

  invoke.addEventListener("click", runInvocation);
  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    runInvocation();
  });

  const requestPane = el("section", { class: "invoke-request" }, [
    el("label", { for: editorId, class: "field-label" }, ["Arguments (JSON)"]),
    el("div", { class: "code-window" }, [
      windowBar("tools/call arguments"),
      editor,
    ]),
    el("div", { class: "invoke-actions" }, [invoke, format, reset]),
    feedback,
  ]);
  const resultPane = el("section", { class: "invoke-result" }, [
    el("h4", { class: "field-label" }, ["Capability result"]),
    el("div", { class: "code-window result-window" }, [
      windowBar(resultState),
      resultView,
    ]),
  ]);

  return el("div", { class: "invoke-panel" }, [
    el("h3", {}, ["Invoke capability"]),
    el("p", { class: "hint" }, [
      "Edit the generated arguments, then send a tools/call request through engine.invoke.",
    ]),
    el("div", { class: "invoke-workspace" }, [requestPane, resultPane]),
    rawSection,
  ]);
}
