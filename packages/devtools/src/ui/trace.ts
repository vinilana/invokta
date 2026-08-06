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
const replaySettleDelayMs = 100;

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
      ? [`${label} — `, el("span", { class: "badge warn" }, ["Truncated"])]
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

function sentenceCase(value: string): string {
  const words = value.replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function loadedStatus(count: number): string {
  return `Live · ${String(count)} ${count === 1 ? "entry" : "entries"} loaded · newest first.`;
}

function renderEntry(entry: TraceEntryView): HTMLElement {
  if (entry.kind === "invocation" && entry.invocation !== undefined) {
    const invocation = entry.invocation;
    const outcome =
      invocation.outcome === "completed"
        ? "Completed"
        : invocation.errorCode === undefined
          ? "Failed"
          : `Failed · ${invocation.errorCode}`;
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
  const notice = sentenceCase(entry.notice ?? "notice");
  return el("div", { class: "trace-row notice" }, [
    timestamp(entry),
    el("span", { class: "badge warn" }, ["Lifecycle"]),
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
  const warning = el(
    "p",
    { id: "trace-data-warning", class: "hint", role: "note" },
    [
      el("span", { class: "badge warn" }, ["Sensitive data"]),
      " Raw request and response bodies from all connected MCP clients appear here and may contain sensitive data.",
    ],
  );
  const empty = el("p", { class: "empty" }, [
    "No activity yet. Invoke a capability or connect an MCP client to start tracing.",
  ]);
  const list = el(
    "div",
    {
      class: "trace-list",
      role: "log",
      "aria-labelledby": "trace-heading",
      "aria-describedby": "trace-status trace-data-warning",
      "aria-live": "off",
      "aria-relevant": "additions",
      "aria-busy": "true",
    },
    [],
  );
  container.append(heading, status, warning, empty, list);

  const visibleKeys: string[] = [];
  const seen = new Set<string>();
  let connected = false;
  let replayPending = true;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelReplaySettlement = (): void => {
    if (settleTimer === undefined) return;
    clearTimeout(settleTimer);
    settleTimer = undefined;
  };

  const scheduleReplaySettlement = (): void => {
    if (!connected || !replayPending) return;
    cancelReplaySettlement();
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (!connected) return;
      replayPending = false;
      list.setAttribute("aria-busy", "false");
      list.setAttribute("aria-live", "polite");
      status.textContent = loadedStatus(list.childElementCount);
    }, replaySettleDelayMs);
  };

  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    connected = true;
    replayPending = true;
    list.setAttribute("aria-live", "off");
    list.setAttribute("aria-busy", "true");
    status.textContent = "Connected · loading recent activity…";
    scheduleReplaySettlement();
  });
  source.addEventListener("error", () => {
    connected = false;
    replayPending = true;
    cancelReplaySettlement();
    list.setAttribute("aria-live", "off");
    list.setAttribute("aria-busy", "true");
    status.textContent =
      "Disconnected · retrying automatically; existing entries remain visible.";
  });
  source.addEventListener("trace", (event) => {
    try {
      const entry = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as TraceEntryView;
      const key = `${String(entry.id)}:${entry.at}:${entry.kind}`;
      if (seen.has(key)) {
        scheduleReplaySettlement();
        return;
      }
      seen.add(key);
      visibleKeys.unshift(key);
      empty.hidden = true;
      list.prepend(renderEntry(entry));
      while (list.childElementCount > maximumVisibleEntries) {
        list.lastElementChild?.remove();
        const removed = visibleKeys.pop();
        if (removed !== undefined) seen.delete(removed);
      }
      scheduleReplaySettlement();
    } catch {
      // A malformed frame is dropped; the stream continues.
    }
  });
  return () => {
    connected = false;
    cancelReplaySettlement();
    source.close();
  };
}
