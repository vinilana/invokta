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
): HTMLElement {
  const heading = el(
    "h4",
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
  return el("section", { class: "trace-payload" }, [heading, content]);
}

function sentenceCase(value: string): string {
  const words = value.replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function loadedStatus(count: number): string {
  return `Live · ${String(count)} ${count === 1 ? "entry" : "entries"} loaded · newest first.`;
}

function entryCount(count: number): string {
  return `${String(count)} ${count === 1 ? "entry" : "entries"}`;
}

function entrySubject(kind: string, value: string): HTMLElement {
  return el("span", { class: "trace-entry-subject" }, [
    el("span", { class: "trace-entry-kind" }, [kind]),
    el("code", {}, [value]),
  ]);
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
    return el("div", { class: "trace-row invocation trace-row--invocation" }, [
      timestamp(entry),
      el(
        "span",
        {
          class: `badge ${invocation.outcome === "completed" ? "ok" : "error"}`,
        },
        [outcome],
      ),
      entrySubject("Invocation", invocation.capabilityId),
      duration(invocation.durationMs),
    ]);
  }
  if (entry.kind === "exchange" && entry.exchange !== undefined) {
    const exchange = entry.exchange;
    return el("details", { class: "trace-row exchange trace-row--exchange" }, [
      el("summary", { title: "Show raw request and response bodies" }, [
        timestamp(entry),
        el("span", { class: `badge ${httpStatusTone(exchange.status)}` }, [
          `HTTP ${String(exchange.status)}`,
        ]),
        entrySubject(
          "MCP exchange",
          exchange.capabilityId ?? exchange.mcpMethod ?? "Unknown method",
        ),
        duration(exchange.durationMs),
      ]),
      el("div", { class: "trace-payload-grid" }, [
        exchangeBody(
          "Request body",
          exchange.requestBody,
          entry.requestTruncated === true,
        ),
        exchangeBody(
          "Response body",
          exchange.responseBody,
          entry.responseTruncated === true,
        ),
      ]),
    ]);
  }
  const notice = sentenceCase(entry.notice ?? "notice");
  return el("div", { class: "trace-row notice trace-row--notice" }, [
    timestamp(entry),
    el("span", { class: "badge warn" }, ["Lifecycle"]),
    el("span", { class: "trace-entry-message" }, [notice]),
  ]);
}

/**
 * The live invocation timeline: every entry the dev server traces arrives
 * over the `/api/events` stream, newest first, including a replay of the
 * session buffer on connect.
 */
export function renderTracePanel(container: HTMLElement): () => void {
  const heading = el("h2", { id: "trace-heading" }, ["Activity"]);
  const status = el(
    "p",
    {
      id: "trace-status",
      class: "trace-state trace-state--connecting",
      role: "status",
      "aria-atomic": "true",
    },
    ["Connecting to live trace…"],
  );
  const warning = el(
    "aside",
    { id: "trace-data-warning", class: "trace-safety-note", role: "note" },
    [
      el("span", { class: "badge warn" }, ["Sensitive data"]),
      el("div", { class: "trace-safety-copy" }, [
        el("strong", {}, ["Raw payloads are visible in this session"]),
        el("p", {}, [
          "Raw request and response bodies from all connected MCP clients appear here and may contain sensitive data.",
        ]),
      ]),
    ],
  );
  const empty = el("div", { class: "trace-empty" }, [
    el("p", { class: "trace-empty-title" }, ["No activity yet"]),
    el("p", { class: "hint" }, [
      "Invoke a capability or connect an MCP client to start tracing.",
    ]),
  ]);
  const count = el(
    "span",
    { id: "trace-count", class: "trace-count", "aria-hidden": "true" },
    [entryCount(0)],
  );
  const list = el(
    "div",
    {
      class: "trace-list",
      role: "log",
      "aria-labelledby": "trace-feed-heading",
      "aria-describedby": "trace-status trace-data-warning",
      "aria-live": "off",
      "aria-relevant": "additions",
      "aria-busy": "true",
    },
    [],
  );
  const panel = el(
    "section",
    { class: "trace-panel", "aria-labelledby": "trace-heading" },
    [
      el("header", { class: "trace-header" }, [
        el("div", { class: "trace-heading-group" }, [
          heading,
          el("p", { class: "trace-description" }, [
            "Live engine and MCP traffic for this development session.",
          ]),
        ]),
        status,
      ]),
      warning,
      el(
        "section",
        { class: "trace-feed", "aria-labelledby": "trace-feed-heading" },
        [
          el("header", { class: "trace-feed-header" }, [
            el("h3", { id: "trace-feed-heading" }, ["Session activity"]),
            count,
          ]),
          empty,
          list,
        ],
      ),
    ],
  );
  container.append(panel);

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
      status.setAttribute("class", "trace-state trace-state--live");
      status.textContent = loadedStatus(list.childElementCount);
    }, replaySettleDelayMs);
  };

  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    connected = true;
    replayPending = true;
    list.setAttribute("aria-live", "off");
    list.setAttribute("aria-busy", "true");
    status.setAttribute("class", "trace-state trace-state--connected");
    status.textContent = "Connected · loading recent activity…";
    scheduleReplaySettlement();
  });
  source.addEventListener("error", () => {
    connected = false;
    replayPending = true;
    cancelReplaySettlement();
    list.setAttribute("aria-live", "off");
    list.setAttribute("aria-busy", "true");
    status.setAttribute("class", "trace-state trace-state--disconnected");
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
      count.textContent = entryCount(list.childElementCount);
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
