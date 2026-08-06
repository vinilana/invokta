import { afterEach, describe, expect, it, vi } from "vitest";

const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const originalEventSource = Object.getOwnPropertyDescriptor(
  globalThis,
  "EventSource",
);

function installGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

class FakeNode extends EventTarget {
  parentNode = null;

  remove() {
    if (this.parentNode === null) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index !== -1) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(value) {
    super();
    this.value = value;
  }

  get textContent() {
    return this.value;
  }

  set textContent(value) {
    this.value = value;
  }
}

class FakeElement extends FakeNode {
  #attributes = new Map();
  childNodes = [];
  hidden = false;
  focusCalls = 0;
  value = "";

  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  focus() {
    this.focusCalls += 1;
  }

  setAttribute(name, value) {
    this.#attributes.set(name, value);
  }

  getAttribute(name) {
    return this.#attributes.get(name) ?? null;
  }

  append(...children) {
    for (const child of children) {
      const node = typeof child === "string" ? new FakeText(child) : child;
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  prepend(...children) {
    for (const child of children.reverse()) {
      const node = typeof child === "string" ? new FakeText(child) : child;
      node.parentNode = this;
      this.childNodes.unshift(node);
    }
  }

  get lastElementChild() {
    return (
      [...this.childNodes]
        .reverse()
        .find((child) => child instanceof FakeElement) ?? null
    );
  }

  get childElementCount() {
    return this.childNodes.filter((child) => child instanceof FakeElement)
      .length;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== "") this.append(String(value));
  }
}

function walk(element) {
  return [
    element,
    ...element.childNodes.flatMap((child) =>
      child instanceof FakeElement ? walk(child) : [],
    ),
  ];
}

function byClass(root, className) {
  return walk(root).filter(
    (node) => node.getAttribute?.("class") === className,
  );
}

function click(element) {
  element.dispatchEvent(new Event("click"));
}

function dispatchTrace(source, entry) {
  const event = new Event("trace");
  Object.defineProperty(event, "data", { value: JSON.stringify(entry) });
  source.dispatchEvent(event);
}

function installTraceEnvironment() {
  installGlobal("document", {
    createElement: (tagName) => new FakeElement(tagName),
  });
  const sources = [];
  class FakeEventSource extends EventTarget {
    closed = false;

    constructor(url) {
      super();
      this.url = url;
      sources.push(this);
    }

    close() {
      this.closed = true;
    }
  }
  installGlobal("EventSource", FakeEventSource);
  return sources;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  if (originalDocument === undefined) delete globalThis.document;
  else Object.defineProperty(globalThis, "document", originalDocument);
  if (originalEventSource === undefined) delete globalThis.EventSource;
  else Object.defineProperty(globalThis, "EventSource", originalEventSource);
});

describe("trace panel", () => {
  it("renders a compact, accessible live log without changing stream cleanup", async () => {
    vi.useFakeTimers();
    const sources = installTraceEnvironment();

    const { renderTracePanel } = await import("../src/ui/trace.js");
    const container = new FakeElement("main");
    const dispose = renderTracePanel(container);
    const nodes = walk(container);
    const heading = nodes.find((node) => node.tagName === "H2");
    const panel = nodes.find(
      (node) => node.getAttribute?.("class") === "trace-panel",
    );
    const header = nodes.find(
      (node) => node.getAttribute?.("class") === "trace-header",
    );
    const status = nodes.find(
      (node) => node.getAttribute?.("role") === "status",
    );
    const log = nodes.find((node) => node.getAttribute?.("role") === "log");
    const warning = nodes.find(
      (node) => node.getAttribute?.("role") === "note",
    );
    const feedHeading = nodes.find(
      (node) => node.getAttribute?.("id") === "trace-feed-heading",
    );
    const count = nodes.find(
      (node) => node.getAttribute?.("id") === "trace-count",
    );
    const empty = nodes.find(
      (node) => node.getAttribute?.("class") === "trace-empty",
    );

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("/api/events");
    expect(panel).toBeDefined();
    expect(header).toBeDefined();
    expect(heading.getAttribute("id")).toBe("trace-heading");
    expect(heading.textContent).toBe("Activity");
    expect(status.getAttribute("id")).toBe("trace-status");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.getAttribute("class")).toContain("trace-state--connecting");
    expect(feedHeading.textContent).toBe("Session activity");
    expect(count.textContent).toBe("0 entries");
    expect(count.getAttribute("aria-hidden")).toBe("true");
    expect(log.getAttribute("aria-labelledby")).toBe("trace-feed-heading");
    expect(log.getAttribute("aria-describedby")).toBe(
      "trace-status trace-data-warning",
    );
    expect(log.getAttribute("aria-live")).toBe("off");
    expect(log.getAttribute("aria-relevant")).toBe("additions");
    expect(log.getAttribute("aria-busy")).toBe("true");
    expect(warning.textContent).toContain(
      "Raw request and response bodies from all connected MCP clients",
    );
    expect(warning.getAttribute("id")).toBe("trace-data-warning");
    expect(warning.getAttribute("class")).toBe("trace-safety-note");
    expect(warning.textContent).toContain("sensitive data");
    expect(empty.textContent).toContain("No activity yet");
    expect(empty.textContent).toContain(
      "Invoke a capability or connect an MCP client to start tracing.",
    );
    expect(empty.hidden).toBe(false);

    sources[0].dispatchEvent(new Event("open"));
    expect(status.textContent).toBe("Connected · loading recent activity…");
    expect(status.getAttribute("class")).toContain("trace-state--connected");
    expect(log.getAttribute("aria-live")).toBe("off");
    expect(log.getAttribute("aria-busy")).toBe("true");

    dispatchTrace(sources[0], {
      kind: "invocation",
      id: 1,
      at: "2026-08-06T12:00:00.000Z",
      invocation: {
        capabilityId: "support.classify",
        durationMs: 4.24,
        outcome: "failed",
        errorCode: "INVALID_INPUT",
      },
    });
    dispatchTrace(sources[0], {
      kind: "exchange",
      id: 2,
      at: "2026-08-06T12:00:01.000Z",
      exchange: {
        status: 503,
        durationMs: 8.75,
        mcpMethod: "tools/call",
        capabilityId: "support.classify",
        requestBody: '{"request":true}',
        responseBody: '{"error":true}',
      },
      requestTruncated: true,
      responseTruncated: false,
    });
    dispatchTrace(sources[0], {
      kind: "notice",
      id: 3,
      at: "2026-08-06T12:00:02.000Z",
      notice: "engine-restarted",
    });

    expect(log.childElementCount).toBe(3);
    expect(empty.hidden).toBe(true);
    expect(log.textContent).toContain("Failed · INVALID_INPUT");
    expect(log.textContent).toContain("HTTP 503");
    expect(log.textContent).toContain("Request body — Truncated");
    expect(log.textContent).toContain("Engine restarted");
    expect(count.textContent).toBe("3 entries");
    expect(
      walk(log).find((node) => node.textContent === "Invocation"),
    ).toBeDefined();
    expect(
      walk(log).find((node) => node.textContent === "MCP exchange"),
    ).toBeDefined();
    expect(
      walk(log).find((node) => node.textContent === "Lifecycle"),
    ).toBeDefined();
    expect(
      walk(log).find(
        (node) => node.getAttribute?.("class") === "trace-payload-grid",
      ),
    ).toBeDefined();
    expect(log.getAttribute("aria-live")).toBe("off");
    expect(log.getAttribute("aria-busy")).toBe("true");

    await vi.advanceTimersByTimeAsync(100);
    expect(status.textContent).toBe("Live · 3 entries loaded · newest first.");
    expect(status.getAttribute("class")).toContain("trace-state--live");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("aria-busy")).toBe("false");
    const times = walk(log).filter((node) => node.tagName === "TIME");
    expect(times[0].textContent).toMatch(/Z$/);
    expect(times[0].getAttribute("datetime")).toBe("2026-08-06T12:00:02.000Z");
    const responseBody = walk(log).find(
      (node) => node.getAttribute?.("aria-label") === "Response body",
    );
    expect(responseBody.tagName).toBe("PRE");
    expect(responseBody.getAttribute("tabindex")).toBe("0");
    expect(responseBody.textContent).toBe('{"error":true}');
    const httpStatus = walk(log).find(
      (node) => node.textContent === "HTTP 503",
    );
    expect(httpStatus.getAttribute("class")).toContain("error");

    sources[0].dispatchEvent(new Event("error"));
    expect(status.textContent).toBe(
      "Disconnected · retrying automatically; existing entries remain visible.",
    );
    expect(status.getAttribute("class")).toContain("trace-state--disconnected");
    expect(log.getAttribute("aria-live")).toBe("off");
    expect(log.getAttribute("aria-busy")).toBe("true");

    dispose();
    expect(sources[0].closed).toBe(true);
  });

  it("suppresses replay announcements while preserving dedupe, order, and the visible cap", async () => {
    vi.useFakeTimers();
    const sources = installTraceEnvironment();
    const { renderTracePanel } = await import("../src/ui/trace.js");
    const container = new FakeElement("main");
    const dispose = renderTracePanel(container);
    const log = walk(container).find(
      (node) => node.getAttribute?.("role") === "log",
    );
    const status = walk(container).find(
      (node) => node.getAttribute?.("role") === "status",
    );

    sources[0].dispatchEvent(new Event("open"));
    for (let id = 1; id <= 501; id += 1) {
      dispatchTrace(sources[0], {
        kind: "notice",
        id,
        at: `2026-08-06T12:00:${String(id).padStart(3, "0")}Z`,
        notice: `replay-${String(id)}`,
      });
    }
    dispatchTrace(sources[0], {
      kind: "notice",
      id: 501,
      at: "2026-08-06T12:00:501Z",
      notice: "replay-501",
    });

    expect(log.getAttribute("aria-live")).toBe("off");
    expect(log.getAttribute("aria-busy")).toBe("true");
    expect(log.childElementCount).toBe(500);
    expect(log.childNodes[0].textContent).toContain("Replay 501");
    expect(log.childNodes[499].textContent).toContain("Replay 2");

    await vi.advanceTimersByTimeAsync(100);
    expect(status.textContent).toBe(
      "Live · 500 entries loaded · newest first.",
    );
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("aria-busy")).toBe("false");

    dispatchTrace(sources[0], {
      kind: "notice",
      id: 502,
      at: "2026-08-06T12:00:502Z",
      notice: "live-502",
    });
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.childElementCount).toBe(500);
    expect(log.childNodes[0].textContent).toContain("Live 502");
    expect(log.childNodes[499].textContent).toContain("Replay 3");

    dispose();
    expect(sources[0].closed).toBe(true);
  });

  it("filters, holds, and clears the view without disturbing the stream", async () => {
    vi.useFakeTimers();
    const sources = installTraceEnvironment();
    const { renderTracePanel } = await import("../src/ui/trace.js");
    const container = new FakeElement("main");
    const dispose = renderTracePanel(container);
    const nodes = walk(container);
    const log = nodes.find((node) => node.getAttribute?.("role") === "log");
    const count = nodes.find(
      (node) => node.getAttribute?.("id") === "trace-count",
    );
    const empty = nodes.find(
      (node) => node.getAttribute?.("class") === "trace-empty",
    );
    const [filterEmpty] = byClass(container, "trace-empty trace-filter-empty");
    const search = nodes.find(
      (node) => node.getAttribute?.("id") === "trace-search",
    );
    const kinds = byClass(container, "trace-kind-choice");
    const [hold, clearView] = byClass(container, "trace-toolbar-button");

    expect(kinds.map((button) => button.textContent)).toEqual([
      "All",
      "Invocations",
      "Exchanges",
      "Lifecycle",
    ]);
    expect(kinds[0].getAttribute("aria-checked")).toBe("true");
    expect(filterEmpty.hidden).toBe(true);
    expect(search.getAttribute("aria-controls")).toBe("trace-list");

    sources[0].dispatchEvent(new Event("open"));
    dispatchTrace(sources[0], {
      kind: "invocation",
      id: 1,
      at: "2026-08-06T12:00:00.000Z",
      invocation: {
        capabilityId: "support.classify",
        durationMs: 4,
        outcome: "completed",
      },
    });
    dispatchTrace(sources[0], {
      kind: "exchange",
      id: 2,
      at: "2026-08-06T12:00:01.000Z",
      exchange: {
        status: 200,
        durationMs: 8,
        mcpMethod: "tools/list",
        requestBody: '{"needle":"payload-marker"}',
        responseBody: "{}",
      },
    });
    dispatchTrace(sources[0], {
      kind: "notice",
      id: 3,
      at: "2026-08-06T12:00:02.000Z",
      notice: "engine-restarted",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(count.textContent).toBe("3 entries");

    click(kinds[1]);
    expect(kinds[1].getAttribute("aria-checked")).toBe("true");
    expect(kinds[0].getAttribute("aria-checked")).toBe("false");
    expect(count.textContent).toBe("1 of 3 entries");
    expect(log.childNodes.filter((node) => !node.hidden)).toHaveLength(1);
    expect(log.childNodes.find((node) => !node.hidden).textContent).toContain(
      "support.classify",
    );

    click(kinds[0]);
    expect(count.textContent).toBe("3 entries");

    search.value = "payload-marker";
    search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("1 of 3 entries");
    expect(log.childNodes.find((node) => !node.hidden).textContent).toContain(
      "HTTP 200",
    );
    expect(filterEmpty.hidden).toBe(true);

    search.value = "absent-needle";
    search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("0 of 3 entries");
    expect(filterEmpty.hidden).toBe(false);
    expect(empty.hidden).toBe(true);

    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("3 entries");
    expect(filterEmpty.hidden).toBe(true);

    expect(hold.textContent).toBe("Hold");
    click(hold);
    expect(hold.getAttribute("aria-pressed")).toBe("true");
    dispatchTrace(sources[0], {
      kind: "notice",
      id: 4,
      at: "2026-08-06T12:00:03.000Z",
      notice: "engine-restarted",
    });
    expect(log.childElementCount).toBe(3);
    expect(hold.textContent).toBe("Held · 1 waiting");

    click(hold);
    expect(hold.getAttribute("aria-pressed")).toBe("false");
    expect(hold.textContent).toBe("Hold");
    expect(log.childElementCount).toBe(4);
    expect(count.textContent).toBe("4 entries");

    click(clearView);
    expect(log.childElementCount).toBe(0);
    expect(count.textContent).toBe("0 entries");
    expect(empty.hidden).toBe(false);
    expect(filterEmpty.hidden).toBe(true);

    dispatchTrace(sources[0], {
      kind: "notice",
      id: 5,
      at: "2026-08-06T12:00:04.000Z",
      notice: "engine-restarted",
    });
    expect(log.childElementCount).toBe(1);
    expect(sources[0].closed).toBe(false);

    dispose();
    expect(sources[0].closed).toBe(true);
  });
});
