import { type CapabilityInfo, callTool } from "./api.js";
import { el, pretty } from "./dom.js";
import { exampleFromSchema } from "./example-from-schema.js";
import { parseMcpResponse } from "./mcp-response.js";
import { getActiveToken } from "./principals.js";

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
      rows: "10",
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
      "aria-label": "Invocation response",
      "aria-live": "polite",
      "aria-atomic": "true",
      "aria-busy": "false",
    },
    ["No response yet. Send an MCP request to inspect structured output."],
  );
  const resultState = el("span", {}, ["Response · not sent"]);

  const windowBar = (label: string | HTMLElement): HTMLElement =>
    el("div", { class: "code-window-bar" }, [
      el("span", { class: "window-dots", "aria-hidden": "true" }, [
        el("span", {}, []),
        el("span", {}, []),
        el("span", {}, []),
      ]),
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
    el("summary", {}, ["MCP exchange (request and response)"]),
    el("h4", {}, ["Request · POST /mcp"]),
    rawRequest,
    el("h4", {}, ["Response"]),
    rawResponse,
  ]);
  rawSection.hidden = true;

  const showResponse = (
    state: string,
    content: string,
    isError = false,
  ): void => {
    resultState.textContent = `Response · ${state}`;
    resultView.textContent = content;
    resultView.classList.toggle("error", isError);
  };

  const reset = el("button", { type: "button" }, ["Reset example"]);
  reset.addEventListener("click", () => {
    editor.value = pretty(exampleFromSchema(capability.inputSchema));
    editor.setAttribute("aria-invalid", "false");
    feedback.textContent = "";
    showResponse(
      "not sent",
      "No response yet. Send an MCP request to inspect structured output.",
    );
    rawRequest.textContent = "";
    rawResponse.textContent = "";
    rawSection.hidden = true;
  });

  editor.addEventListener("input", () => {
    if (editor.getAttribute("aria-invalid") === "true") {
      editor.setAttribute("aria-invalid", "false");
      feedback.textContent = "";
    }
  });

  const invoke = el("button", { type: "button", class: "primary" }, [
    "Send MCP request",
  ]);
  invoke.addEventListener("click", () => {
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
      feedback.textContent =
        "Input error: The request arguments are not valid JSON.";
      showResponse(
        "not sent",
        "Request not sent because the input is invalid.",
      );
      return;
    }
    invoke.disabled = true;
    reset.disabled = true;
    invoke.textContent = "Sending…";
    resultView.setAttribute("aria-busy", "true");
    showResponse("pending", `Waiting for ${capability.id}…`);
    void callTool(capability.id, args, getActiveToken())
      .then((exchange) => {
        rawSection.hidden = false;
        rawRequest.textContent = exchange.requestBody;
        rawResponse.textContent = `HTTP ${String(exchange.status)}\n${exchange.responseBody}`;
        if (exchange.status === 401) {
          feedback.textContent =
            "Authentication failed (HTTP 401). Select a principal with a minted token and send the request again.";
          showResponse(
            "HTTP 401",
            exchange.responseBody || "The MCP endpoint returned no body.",
            true,
          );
          return;
        }
        if (exchange.status < 200 || exchange.status >= 300) {
          feedback.textContent = `MCP request failed (HTTP ${String(exchange.status)}). Inspect the exchange for details.`;
          showResponse(
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
              "MCP returned a protocol error. Inspect the exchange for details.";
            showResponse("protocol error", pretty(message.error), true);
            return;
          }
          feedback.textContent =
            "The MCP response could not be parsed. Inspect the exchange for details.";
          showResponse(
            "unreadable",
            exchange.responseBody || "The MCP endpoint returned no body.",
            true,
          );
          return;
        }
        if (result.isError === true) {
          feedback.textContent = "The capability returned an engine error.";
          showResponse(
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
        showResponse("success", pretty(output));
      })
      .catch(() => {
        feedback.textContent =
          "MCP endpoint unreachable. Confirm the dev server is running and try again.";
        showResponse("no response", "No response received.", true);
      })
      .finally(() => {
        resultView.setAttribute("aria-busy", "false");
        invoke.disabled = false;
        reset.disabled = false;
        invoke.textContent = "Send MCP request";
      });
  });

  return el("div", { class: "invoke-panel" }, [
    el("h3", {}, ["Test invocation"]),
    el("p", { class: "hint" }, [
      "Edit the generated arguments, then send a real MCP tools/call request through the engine's invoke path.",
    ]),
    el("label", { for: editorId, class: "field-label" }, [
      "Request arguments (JSON)",
    ]),
    el("div", { class: "code-window" }, [windowBar("MCP arguments"), editor]),
    el("div", { class: "invoke-actions" }, [invoke, reset]),
    feedback,
    el("div", { class: "code-window result-window" }, [
      windowBar(resultState),
      resultView,
    ]),
    rawSection,
  ]);
}
