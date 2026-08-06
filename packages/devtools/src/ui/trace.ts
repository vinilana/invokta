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
  readonly requestTruncated?: boolean;
  readonly responseTruncated?: boolean;
  readonly notice?: string;
}

const maximumVisibleEntries = 500;

function timeOf(entry: TraceEntryView): string {
  const index = entry.at.indexOf("T");
  return index === -1 ? entry.at : entry.at.slice(index + 1);
}

function timestamp(entry: TraceEntryView): HTMLTimeElement {
  return el(
    "time",
    {
      class: "time",
      datetime: entry.at,
      title: entry.at,
      "aria-label": `Recorded at ${entry.at}`,
    },
    [timeOf(entry)],
  );
}

function duration(durationMs: number): HTMLSpanElement {
  const value = durationMs.toFixed(1);
  return el(
    "span",
    {
      class: "duration",
      "aria-label": `Duration ${value} milliseconds`,
    },
    [`${value} ms`],
  );
}

function httpStatusTone(status: number): "ok" | "error" | "warn" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400) return "error";
  return "warn";
}

function exchangeBody(
  label: string,
  body: string,
  truncated: boolean,
): readonly [HTMLHeadingElement, HTMLPreElement] {
  const heading = el(
    "h3",
    { class: "field-label" },
    truncated
      ? [`${label} — `, el("span", { class: "badge warn" }, ["truncated"])]
      : [label],
  );
  const content = el(
    "pre",
    {
      class: "raw",
      role: "region",
      "aria-label": label,
      tabindex: "0",
    },
    [body],
  );
  return [heading, content];
}

function renderEntry(entry: TraceEntryView): HTMLElement {
  if (entry.kind === "invocation" && entry.invocation !== undefined) {
    const invocation = entry.invocation;
    const outcome =
      invocation.outcome === "completed"
        ? "completed"
        : invocation.errorCode === undefined
          ? "failed"
          : `failed · ${invocation.errorCode}`;
    return el("div", { class: "trace-row invocation" }, [
      timestamp(entry),
      el(
        "span",
        {
          class: `badge ${invocation.outcome === "completed" ? "ok" : "error"}`,
        },
        [outcome],
      ),
      el("code", {}, [invocation.capabilityId]),
      duration(invocation.durationMs),
    ]);
  }
  if (entry.kind === "exchange" && entry.exchange !== undefined) {
    const exchange = entry.exchange;
    return el("details", { class: "trace-row exchange" }, [
      el("summary", { title: "Show raw request and response bodies" }, [
        timestamp(entry),
        el("span", { class: `badge ${httpStatusTone(exchange.status)}` }, [
          `HTTP ${String(exchange.status)}`,
        ]),
        el("code", {}, [
          exchange.capabilityId ?? exchange.mcpMethod ?? "MCP exchange",
        ]),
        duration(exchange.durationMs),
      ]),
      ...exchangeBody(
        "Request body",
        exchange.requestBody,
        entry.requestTruncated === true,
      ),
      ...exchangeBody(
        "Response body",
        exchange.responseBody,
        entry.responseTruncated === true,
      ),
    ]);
  }
  const notice = (entry.notice ?? "notice").replaceAll("-", " ");
  return el("div", { class: "trace-row notice" }, [
    timestamp(entry),
    el("span", { class: "badge warn" }, ["lifecycle"]),
    el("span", {}, [notice]),
  ]);
}

/**
 * The live invocation timeline: every entry the dev server traces arrives
 * over the `/api/events` stream, newest first, including a replay of the
 * session buffer on connect.
 */
export function renderTracePanel(container: HTMLElement): () => void {
  const heading = el("h2", { id: "trace-heading" }, ["Trace"]);
  const status = el(
    "p",
    {
      id: "trace-status",
      class: "hint",
      role: "status",
      "aria-atomic": "true",
    },
    ["Connecting to live trace…"],
  );
  const list = el(
    "div",
    {
      class: "trace-list",
      role: "log",
      "aria-labelledby": "trace-heading",
      "aria-describedby": "trace-status",
      "aria-live": "polite",
      "aria-relevant": "additions",
      "aria-busy": "true",
    },
    [],
  );
  container.append(heading, status, list);

  const visibleKeys: string[] = [];
  const seen = new Set<string>();
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    status.textContent = "Live · all MCP clients · newest first.";
    list.setAttribute("aria-busy", "false");
  });
  source.addEventListener("error", () => {
    status.textContent = "Connection lost · reconnecting…";
    list.setAttribute("aria-busy", "true");
  });
  source.addEventListener("trace", (event) => {
    try {
      const entry = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as TraceEntryView;
      const key = `${String(entry.id)}:${entry.at}:${entry.kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      visibleKeys.unshift(key);
      list.prepend(renderEntry(entry));
      while (list.childElementCount > maximumVisibleEntries) {
        list.lastElementChild?.remove();
        const removed = visibleKeys.pop();
        if (removed !== undefined) seen.delete(removed);
      }
    } catch {
      // A malformed frame is dropped; the stream continues.
    }
  });
  return () => {
    source.close();
  };
}
