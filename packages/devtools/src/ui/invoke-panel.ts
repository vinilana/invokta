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
  const editor = el("textarea", { rows: "10", class: "editor" }, [
    pretty(exampleFromSchema(capability.inputSchema)),
  ]);
  const feedback = el("p", { class: "feedback" }, []);
  const resultView = el("pre", { class: "result" }, []);
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
  });

  const invoke = el("button", { type: "button", class: "primary" }, ["Invoke"]);
  invoke.addEventListener("click", () => {
    feedback.textContent = "";
    resultView.textContent = "";
    let args: unknown;
    try {
      args = JSON.parse(editor.value);
    } catch {
      feedback.textContent = "The input is not valid JSON.";
      return;
    }
    invoke.disabled = true;
    void callTool(capability.id, args, getActiveToken())
      .then((exchange) => {
        rawSection.hidden = false;
        rawRequest.textContent = exchange.requestBody;
        rawResponse.textContent = `HTTP ${String(exchange.status)}\n${exchange.responseBody}`;
        if (exchange.status === 401) {
          feedback.textContent =
            "401 unauthorized — select a principal with a minted token.";
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
      });
  });

  return el("div", { class: "invoke-panel" }, [
    el("h3", {}, ["Invoke"]),
    editor,
    el("div", { class: "invoke-actions" }, [invoke, reset]),
    feedback,
    el("h4", {}, ["Result"]),
    resultView,
    rawSection,
  ]);
}
