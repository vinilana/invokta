import { el } from "./dom.js";

interface TraceEntryView {
  readonly kind: "invocation" | "exchange" | "notice";
  readonly id: number;
  readonly at: string;
  readonly invocation?: {
    readonly capabilityId: string;
    readonly durationMs: number;
    readonly outcome: "completed" | "failed";
    readonly errorCode?: string;
  };
  readonly exchange?: {
    readonly status: number;
    readonly durationMs: number;
    readonly mcpMethod?: string;
    readonly capabilityId?: string;
    readonly requestBody: string;
    readonly responseBody: string;
  };
  readonly notice?: string;
}

function timeOf(entry: TraceEntryView): string {
  const index = entry.at.indexOf("T");
  return index === -1 ? entry.at : entry.at.slice(index + 1).replace("Z", "");
}

function renderEntry(entry: TraceEntryView): HTMLElement {
  if (entry.kind === "invocation" && entry.invocation !== undefined) {
    const invocation = entry.invocation;
    return el("div", { class: "trace-row invocation" }, [
      el("span", { class: "time" }, [timeOf(entry)]),
      el(
        "span",
        {
          class: `badge ${invocation.outcome === "completed" ? "ok" : "error"}`,
        },
        [
          invocation.outcome === "completed"
            ? "completed"
            : (invocation.errorCode ?? "failed"),
        ],
      ),
      el("code", {}, [invocation.capabilityId]),
      el("span", { class: "duration" }, [
        `${invocation.durationMs.toFixed(1)} ms`,
      ]),
    ]);
  }
  if (entry.kind === "exchange" && entry.exchange !== undefined) {
    const exchange = entry.exchange;
    return el("details", { class: "trace-row exchange" }, [
      el("summary", {}, [
        el("span", { class: "time" }, [timeOf(entry)]),
        el("span", { class: "badge" }, [`HTTP ${String(exchange.status)}`]),
        el("code", {}, [
          exchange.capabilityId ?? exchange.mcpMethod ?? "exchange",
        ]),
        el("span", { class: "duration" }, [
          `${exchange.durationMs.toFixed(1)} ms`,
        ]),
      ]),
      el("h4", {}, ["Request"]),
      el("pre", { class: "raw" }, [exchange.requestBody]),
      el("h4", {}, ["Response"]),
      el("pre", { class: "raw" }, [exchange.responseBody]),
    ]);
  }
  return el("div", { class: "trace-row notice" }, [
    el("span", { class: "time" }, [timeOf(entry)]),
    el("span", { class: "badge warn" }, [entry.notice ?? "notice"]),
  ]);
}

/**
 * The live invocation timeline: every entry the dev server traces arrives
 * over the `/api/events` stream, newest first, including a replay of the
 * session buffer on connect.
 */
export function renderTracePanel(container: HTMLElement): void {
  const list = el("div", { class: "trace-list" }, []);
  const status = el("p", { class: "hint" }, ["Connecting to /api/events…"]);
  container.append(el("h2", {}, ["Trace"]), status, list);

  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    status.textContent =
      "Live. Invocations from every MCP client of this dev server appear here.";
  });
  source.addEventListener("error", () => {
    status.textContent = "Reconnecting to /api/events…";
  });
  source.addEventListener("trace", (event) => {
    try {
      const entry = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as TraceEntryView;
      list.prepend(renderEntry(entry));
      while (list.childElementCount > 500) list.lastElementChild?.remove();
    } catch {
      // A malformed frame is dropped; the stream continues.
    }
  });
}
