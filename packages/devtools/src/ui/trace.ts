import { createCopyButton } from "./clipboard.js";
import { el } from "./dom.js";
import { openCapabilityInPlayground } from "./playground-handoff.js";

interface TraceEntryView {
  readonly kind: "invocation" | "exchange" | "adapter" | "notice";
  readonly id: number;
  readonly at: string;
  readonly call?: {
    readonly adapter: string;
    readonly capabilityId: string;
    readonly outcome: "success" | "capability-error" | "adapter-error";
    readonly durationMs: number;
    readonly errorCode?: string;
    /** The identity the call acted as; `null` when it ran anonymously. */
    readonly principalId?: string | null;
    /** The invocation arguments as JSON, when the server recorded them. */
    readonly input?: string;
    readonly request: string;
    readonly response: string;
    readonly status?: number;
    readonly exitCode?: number | null;
    readonly command?: string;
  };
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
  /** Original body lengths before truncation, when the server reports them. */
  readonly requestOriginalSize?: number;
  readonly responseOriginalSize?: number;
  /** Shared truncation metadata applied to whichever body was truncated. */
  readonly originalSize?: number;
  readonly notice?: string;
  /** Extra lifecycle detail attached to a notice, shown on demand. */
  readonly detail?: string;
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
  originalSize?: number,
): HTMLElement {
  const heading = el(
    "h4",
    { class: "field-label" },
    truncated
      ? [
          `${label} — `,
          el("span", { class: "badge warn" }, [
            originalSize === undefined
              ? "Truncated"
              : `Truncated from ${String(originalSize)} chars`,
          ]),
        ]
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
  return el("section", { class: "trace-payload" }, [
    el("div", { class: "trace-payload-heading" }, [
      heading,
      createCopyButton(label.toLowerCase(), () => body),
    ]),
    content,
  ]);
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

/** The identity an emulated call acted as, which is what an `access` rule saw. */
function actingIdentity(principalId: string | null): HTMLElement {
  return el("span", { class: "trace-entry-identity" }, [
    principalId === null ? "anonymous" : "as ",
    principalId === null ? null : el("code", {}, [principalId]),
  ]);
}

/** Extracts `params.arguments` from a traced JSON-RPC request body. */
function playgroundPrefill(requestBody: string): string {
  try {
    const parsed = JSON.parse(requestBody) as {
      readonly params?: { readonly arguments?: unknown };
    };
    return JSON.stringify(parsed.params?.arguments ?? {});
  } catch {
    return "{}";
  }
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
    const capabilityId = exchange.capabilityId;
    const playground =
      capabilityId === undefined
        ? null
        : el(
            "button",
            {
              type: "button",
              class: "trace-open-playground",
              title: "Edit and re-run this call in Capabilities",
            },
            ["Open in Capabilities"],
          );
    playground?.addEventListener("click", () => {
      if (capabilityId === undefined) return;
      openCapabilityInPlayground(
        capabilityId,
        playgroundPrefill(exchange.requestBody),
      );
    });
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
      playground === null
        ? null
        : el("div", { class: "trace-row-actions" }, [playground]),
      el("div", { class: "trace-payload-grid" }, [
        exchangeBody(
          "Request body",
          exchange.requestBody,
          entry.requestTruncated === true,
          entry.requestOriginalSize ??
            (entry.requestTruncated === true ? entry.originalSize : undefined),
        ),
        exchangeBody(
          "Response body",
          exchange.responseBody,
          entry.responseTruncated === true,
          entry.responseOriginalSize ??
            (entry.responseTruncated === true ? entry.originalSize : undefined),
        ),
      ]),
    ]);
  }
  if (entry.kind === "adapter" && entry.call !== undefined) {
    const call = entry.call;
    const playground = el(
      "button",
      {
        type: "button",
        class: "trace-open-playground",
        title: "Edit and re-run this call in Capabilities",
      },
      ["Open in Capabilities"],
    );
    playground.addEventListener("click", () => {
      // Process adapters record a rendered command as the request, so the
      // recorded arguments are the faithful reproduction whenever present.
      openCapabilityInPlayground(
        call.capabilityId,
        call.input ?? playgroundPrefill(call.request),
      );
    });
    const tone =
      call.outcome === "success"
        ? "ok"
        : call.outcome === "capability-error"
          ? "error"
          : "warn";
    const outcomeLabel =
      call.outcome === "success"
        ? "Success"
        : call.errorCode === undefined
          ? sentenceCase(call.outcome)
          : `${sentenceCase(call.outcome)} · ${call.errorCode}`;
    return el("details", { class: "trace-row adapter trace-row--adapter" }, [
      el("summary", { title: "Show what the adapter exchanged" }, [
        timestamp(entry),
        el("span", { class: `badge ${tone}` }, [outcomeLabel]),
        el("span", { class: "badge" }, [call.adapter]),
        entrySubject("Emulated call", call.capabilityId),
        call.principalId === undefined
          ? null
          : actingIdentity(call.principalId),
        duration(call.durationMs),
      ]),
      el("div", { class: "trace-row-actions" }, [playground]),
      el("div", { class: "trace-payload-grid" }, [
        exchangeBody(
          "Request",
          call.request,
          entry.requestTruncated === true,
          entry.requestOriginalSize,
        ),
        exchangeBody(
          "Response",
          call.response,
          entry.responseTruncated === true,
          entry.responseOriginalSize,
        ),
      ]),
    ]);
  }
  const notice = sentenceCase(entry.notice ?? "notice");
  if (entry.detail !== undefined && entry.detail !== "") {
    return el("details", { class: "trace-row notice trace-row--notice" }, [
      el("summary", { title: "Show lifecycle detail" }, [
        timestamp(entry),
        el("span", { class: "badge warn" }, ["Lifecycle"]),
        el("span", { class: "trace-entry-message" }, [notice]),
      ]),
      el("pre", { class: "raw trace-notice-detail" }, [entry.detail]),
    ]);
  }
  return el("div", { class: "trace-row notice trace-row--notice" }, [
    timestamp(entry),
    el("span", { class: "badge warn" }, ["Lifecycle"]),
    el("span", { class: "trace-entry-message" }, [notice]),
  ]);
}

type TraceKindFilter = "all" | TraceEntryView["kind"];

const kindFilters: ReadonlyArray<{
  readonly value: TraceKindFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "adapter", label: "Emulated calls" },
  { value: "invocation", label: "Invocations" },
  { value: "exchange", label: "Exchanges" },
  { value: "notice", label: "Lifecycle" },
];

/** Everything about one entry a developer might type into the filter box. */
function searchTextOf(entry: TraceEntryView): string {
  const parts: string[] = [entry.kind, entry.at];
  if (entry.invocation !== undefined) {
    parts.push(
      entry.invocation.capabilityId,
      entry.invocation.outcome,
      entry.invocation.errorCode ?? "",
    );
  }
  if (entry.exchange !== undefined) {
    parts.push(
      `http ${String(entry.exchange.status)}`,
      entry.exchange.mcpMethod ?? "",
      entry.exchange.capabilityId ?? "",
      entry.exchange.requestBody,
      entry.exchange.responseBody,
    );
  }
  if (entry.call !== undefined) {
    parts.push(
      entry.call.adapter,
      entry.call.capabilityId,
      entry.call.outcome,
      entry.call.errorCode ?? "",
      entry.call.principalId === undefined
        ? ""
        : (entry.call.principalId ?? "anonymous"),
      entry.call.status === undefined
        ? ""
        : `http ${String(entry.call.status)}`,
      entry.call.request,
      entry.call.response,
    );
  }
  if (entry.notice !== undefined) parts.push(entry.notice);
  if (entry.detail !== undefined) parts.push(entry.detail);
  return parts.join("\n").toLowerCase();
}

interface TraceStatusFilter {
  readonly operator: ">=" | "<=" | ">" | "<" | "=";
  readonly value: number;
}

/**
 * Structured filters parsed out of the search box. Recognized tokens are
 * `capability:<id>`, `outcome:<completed|failed>`, and
 * `status:<op><code>`; everything else stays a free substring search.
 */
interface TraceQuery {
  readonly capability?: string;
  readonly outcome?: string;
  readonly status?: TraceStatusFilter;
  readonly free: string;
}

function parseTraceQuery(raw: string): TraceQuery {
  const free: string[] = [];
  let capability: string | undefined;
  let outcome: string | undefined;
  let status: TraceStatusFilter | undefined;
  for (const token of raw.split(/\s+/).filter((part) => part !== "")) {
    const statusMatch = /^status:(>=|<=|>|<|=)?(\d+)$/.exec(token);
    if (statusMatch !== null) {
      status = {
        operator: (statusMatch[1] ?? "=") as TraceStatusFilter["operator"],
        value: Number(statusMatch[2]),
      };
      continue;
    }
    if (token.startsWith("capability:")) {
      capability = token.slice("capability:".length);
      continue;
    }
    if (token.startsWith("outcome:")) {
      outcome = token.slice("outcome:".length);
      continue;
    }
    free.push(token);
  }
  return {
    ...(capability === undefined ? {} : { capability }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(status === undefined ? {} : { status }),
    free: free.join(" "),
  };
}

function matchesStatus(status: number, filter: TraceStatusFilter): boolean {
  switch (filter.operator) {
    case ">=":
      return status >= filter.value;
    case "<=":
      return status <= filter.value;
    case ">":
      return status > filter.value;
    case "<":
      return status < filter.value;
    default:
      return status === filter.value;
  }
}

interface TraceRecord {
  readonly key: string;
  readonly kind: TraceEntryView["kind"];
  readonly element: HTMLElement;
  readonly searchText: string;
  readonly capabilityId?: string;
  readonly outcome?: string;
  readonly status?: number;
  readonly isError: boolean;
}

/**
 * The live invocation timeline: every entry the dev server traces arrives
 * over the `/api/events` stream, newest first, including a replay of the
 * session buffer on connect. Filtering, holding, and clearing act on this
 * view only; the dev server's bounded buffer is never mutated from here.
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
  const filterEmpty = el(
    "div",
    { class: "trace-empty trace-filter-empty", role: "status" },
    [
      el("p", { class: "trace-empty-title" }, ["No entries match this filter"]),
      el("p", { class: "hint" }, [
        "Clear the search or choose another kind to see the buffered activity again.",
      ]),
    ],
  );
  filterEmpty.hidden = true;
  const count = el(
    "span",
    { id: "trace-count", class: "trace-count", "aria-hidden": "true" },
    [entryCount(0)],
  );
  const list = el(
    "div",
    {
      id: "trace-list",
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

  const records: TraceRecord[] = [];
  const held: Array<{ readonly key: string; readonly entry: TraceEntryView }> =
    [];
  const seen = new Set<string>();
  let activeKind: TraceKindFilter = "all";
  let errorsOnly = false;
  let droppedEntries = 0;
  let holding = false;
  let connected = false;
  let replayPending = true;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const search = el(
    "input",
    {
      id: "trace-search",
      class: "trace-search",
      type: "search",
      placeholder: "Search, or capability:<id> outcome:failed status:>=400",
      autocomplete: "off",
      "aria-controls": "trace-list",
    },
    [],
  );
  const errorsOnlyToggle = el(
    "button",
    {
      type: "button",
      class: "trace-toolbar-button trace-errors-toggle",
      "aria-pressed": "false",
      title: "Show only failed invocations and error responses",
    },
    ["Errors only"],
  );
  const dropped = el(
    "p",
    {
      id: "trace-dropped",
      class: "trace-dropped",
      role: "note",
    },
    [],
  );
  dropped.hidden = true;
  const hold = el(
    "button",
    {
      type: "button",
      class: "trace-toolbar-button",
      "aria-pressed": "false",
      title: "Stop adding new entries to this view",
    },
    ["Hold"],
  );
  const clearView = el(
    "button",
    {
      type: "button",
      class: "trace-toolbar-button",
      title: "Remove every entry from this view and the server buffer",
    },
    ["Clear view"],
  );
  const kindButtons = new Map<TraceKindFilter, HTMLButtonElement>();
  let query = "";

  const applyFilter = (): void => {
    const parsed = parseTraceQuery(query);
    let visible = 0;
    for (const record of records) {
      const matches =
        (activeKind === "all" || record.kind === activeKind) &&
        (!errorsOnly || record.isError) &&
        (parsed.capability === undefined ||
          record.capabilityId === parsed.capability) &&
        (parsed.outcome === undefined || record.outcome === parsed.outcome) &&
        (parsed.status === undefined ||
          (record.status !== undefined &&
            matchesStatus(record.status, parsed.status))) &&
        (parsed.free === "" || record.searchText.includes(parsed.free));
      record.element.hidden = !matches;
      if (matches) visible += 1;
    }
    const filtering = query !== "" || activeKind !== "all" || errorsOnly;
    count.textContent = filtering
      ? `${String(visible)} of ${entryCount(records.length)}`
      : entryCount(records.length);
    empty.hidden = records.length !== 0;
    filterEmpty.hidden = !(filtering && records.length !== 0 && visible === 0);
  };

  const paintDropped = (): void => {
    dropped.hidden = droppedEntries === 0;
    if (droppedEntries === 0) return;
    dropped.textContent = `Older entries were dropped (view limited to ${String(maximumVisibleEntries)}).`;
  };

  const paintHold = (): void => {
    hold.setAttribute("aria-pressed", String(holding));
    hold.textContent = holding
      ? held.length === 0
        ? "Held"
        : `Held · ${String(held.length)} waiting`
      : "Hold";
  };

  const admit = (key: string, entry: TraceEntryView): void => {
    const capabilityId =
      entry.invocation?.capabilityId ??
      entry.exchange?.capabilityId ??
      entry.call?.capabilityId;
    const outcome =
      entry.invocation?.outcome ??
      (entry.call === undefined
        ? undefined
        : entry.call.outcome === "success"
          ? "completed"
          : "failed");
    const status = entry.exchange?.status ?? entry.call?.status;
    const record: TraceRecord = {
      key,
      kind: entry.kind,
      element: renderEntry(entry),
      searchText: searchTextOf(entry),
      ...(capabilityId === undefined
        ? {}
        : { capabilityId: capabilityId.toLowerCase() }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(status === undefined ? {} : { status }),
      isError: outcome === "failed" || (status !== undefined && status >= 400),
    };
    records.unshift(record);
    list.prepend(record.element);
    while (records.length > maximumVisibleEntries) {
      const evicted = records.pop();
      if (evicted === undefined) break;
      evicted.element.remove();
      seen.delete(evicted.key);
      droppedEntries += 1;
    }
    paintDropped();
  };

  const filterGroup = el(
    "div",
    {
      class: "trace-kind-filter",
      role: "radiogroup",
      "aria-label": "Entry kind",
    },
    kindFilters.map(({ value, label }) => {
      const button = el(
        "button",
        {
          type: "button",
          role: "radio",
          class: "trace-kind-choice",
          "aria-checked": String(value === "all"),
          tabindex: value === "all" ? "0" : "-1",
        },
        [label],
      );
      button.addEventListener("click", () => {
        selectKind(value, true);
      });
      kindButtons.set(value, button);
      return button;
    }),
  );

  function selectKind(value: TraceKindFilter, focus: boolean): void {
    activeKind = value;
    for (const [candidate, button] of kindButtons) {
      const checked = candidate === value;
      button.setAttribute("aria-checked", String(checked));
      button.setAttribute("tabindex", checked ? "0" : "-1");
    }
    applyFilter();
    if (focus) kindButtons.get(value)?.focus();
  }

  filterGroup.addEventListener("keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    const current = kindFilters.findIndex(({ value }) => value === activeKind);
    if (current < 0) return;
    let next = current;
    if (keyboardEvent.key === "ArrowRight" || keyboardEvent.key === "ArrowDown")
      next = current + 1;
    else if (
      keyboardEvent.key === "ArrowLeft" ||
      keyboardEvent.key === "ArrowUp"
    )
      next = current - 1;
    else if (keyboardEvent.key === "Home") next = 0;
    else if (keyboardEvent.key === "End") next = kindFilters.length - 1;
    else return;
    keyboardEvent.preventDefault();
    const choice = kindFilters.at(
      (next + kindFilters.length) % kindFilters.length,
    );
    if (choice !== undefined) selectKind(choice.value, true);
  });

  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    applyFilter();
  });
  search.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape" || query === "") return;
    event.preventDefault();
    search.value = "";
    query = "";
    applyFilter();
  });

  errorsOnlyToggle.addEventListener("click", () => {
    errorsOnly = !errorsOnly;
    errorsOnlyToggle.setAttribute("aria-pressed", String(errorsOnly));
    applyFilter();
  });

  hold.addEventListener("click", () => {
    holding = !holding;
    if (!holding) {
      for (const { key, entry } of held) admit(key, entry);
      held.length = 0;
      applyFilter();
    }
    paintHold();
  });

  clearView.addEventListener("click", () => {
    for (const record of records) record.element.remove();
    records.length = 0;
    held.length = 0;
    seen.clear();
    droppedEntries = 0;
    paintDropped();
    paintHold();
    applyFilter();
    // The server buffer is cleared best-effort; the view is already sane.
    if (typeof fetch === "function") {
      void fetch("/api/trace/clear", { method: "POST" }).catch(() => {});
    }
  });

  const toolbar = el("div", { class: "trace-toolbar" }, [
    el("label", { class: "trace-toolbar-label", for: "trace-search" }, [
      "Filter",
    ]),
    search,
    errorsOnlyToggle,
    filterGroup,
    el("div", { class: "trace-toolbar-actions" }, [hold, clearView]),
  ]);

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
          toolbar,
          dropped,
          empty,
          filterEmpty,
          list,
        ],
      ),
    ],
  );
  container.append(panel);

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
      if (holding) {
        held.push({ key, entry });
        while (held.length > maximumVisibleEntries) {
          const evicted = held.shift();
          if (evicted !== undefined) {
            seen.delete(evicted.key);
            droppedEntries += 1;
          }
        }
        paintDropped();
        paintHold();
        scheduleReplaySettlement();
        return;
      }
      admit(key, entry);
      applyFilter();
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
