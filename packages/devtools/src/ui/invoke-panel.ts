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
  const editorId = `input-${capability.id.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
  const editor = el(
    "textarea",
    {
      id: editorId,
      rows: "10",
      class: "editor",
      spellcheck: "false",
    },
    [pretty(exampleFromSchema(capability.inputSchema))],
  );
  const feedback = el("p", { class: "feedback", role: "alert" }, []);
  const resultView = el("pre", { class: "result", "aria-live": "polite" }, []);
  const rawRequest = el("pre", { class: "raw" }, []);
  const rawResponse = el("pre", { class: "raw" }, []);
  const rawSection = el("details", {}, [
    el("summary", {}, ["Raw MCP exchange"]),
    el("h4", {}, ["Request body (POST /mcp)"]),
    rawRequest,
    el("h4", {}, ["Response body"]),
    rawResponse,
  ]);
  rawSection.hidden = true;

  const reset = el("button", { type: "button" }, ["Reset example"]);
  reset.addEventListener("click", () => {
    editor.value = pretty(exampleFromSchema(capability.inputSchema));
    feedback.textContent = "";
    resultView.textContent = "";
    resultView.classList.remove("error");
    rawRequest.textContent = "";
    rawResponse.textContent = "";
    rawSection.hidden = true;
  });

  const invoke = el("button", { type: "button", class: "primary" }, ["Invoke"]);
  invoke.addEventListener("click", () => {
    feedback.textContent = "";
    resultView.textContent = "";
    resultView.classList.remove("error");
    rawSection.hidden = true;
    let args: unknown;
    try {
      args = JSON.parse(editor.value);
    } catch {
      feedback.textContent = "The input is not valid JSON.";
      return;
    }
    invoke.disabled = true;
    invoke.textContent = "Invoking…";
    void callTool(capability.id, args, getActiveToken())
      .then((exchange) => {
        rawSection.hidden = false;
        rawRequest.textContent = exchange.requestBody;
        rawResponse.textContent = `HTTP ${String(exchange.status)}\n${exchange.responseBody}`;
        if (exchange.status === 401) {
          feedback.textContent =
            "401 unauthorized — select a principal with a minted token.";
          resultView.classList.add("error");
          resultView.textContent = exchange.responseBody;
          return;
        }
        if (exchange.status < 200 || exchange.status >= 300) {
          feedback.textContent = `The MCP request failed with HTTP ${String(exchange.status)}.`;
          resultView.classList.add("error");
          resultView.textContent = exchange.responseBody;
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
            }
          | undefined;
        const result = message?.result;
        if (result === undefined) {
          feedback.textContent = "The MCP response could not be interpreted.";
          resultView.classList.add("error");
          resultView.textContent = exchange.responseBody;
          return;
        }
        if (result.isError === true) {
          feedback.textContent = "The invocation failed with an engine error.";
          resultView.textContent = pretty(
            ((): unknown => {
              const text = result.content?.[0]?.text;
              if (typeof text !== "string") return result;
              try {
                return JSON.parse(text);
              } catch {
                return text;
              }
            })(),
          );
          resultView.classList.add("error");
          return;
        }
        resultView.classList.remove("error");
        resultView.textContent = pretty(result.structuredContent);
      })
      .catch(() => {
        feedback.textContent = "The dev server could not be reached.";
      })
      .finally(() => {
        invoke.disabled = false;
        invoke.textContent = "Invoke";
      });
  });

  return el("div", { class: "invoke-panel" }, [
    el("h3", {}, ["Invoke"]),
    el("label", { for: editorId }, ["JSON input"]),
    editor,
    el("div", { class: "invoke-actions" }, [invoke, reset]),
    feedback,
    el("h4", {}, ["Result"]),
    resultView,
    rawSection,
  ]);
}
