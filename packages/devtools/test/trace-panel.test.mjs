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

  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
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

function dispatchTrace(source, entry) {
  const event = new Event("trace");
  Object.defineProperty(event, "data", { value: JSON.stringify(entry) });
  source.dispatchEvent(event);
}

afterEach(() => {
  vi.resetModules();
  if (originalDocument === undefined) delete globalThis.document;
  else Object.defineProperty(globalThis, "document", originalDocument);
  if (originalEventSource === undefined) delete globalThis.EventSource;
  else Object.defineProperty(globalThis, "EventSource", originalEventSource);
});

describe("trace panel", () => {
  it("renders a compact, accessible live log without changing stream cleanup", async () => {
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

    const { renderTracePanel } = await import("../src/ui/trace.js");
    const container = new FakeElement("main");
    const dispose = renderTracePanel(container);
    const nodes = walk(container);
    const heading = nodes.find((node) => node.tagName === "H2");
    const status = nodes.find(
      (node) => node.getAttribute?.("role") === "status",
    );
    const log = nodes.find((node) => node.getAttribute?.("role") === "log");

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("/api/events");
    expect(heading.getAttribute("id")).toBe("trace-heading");
    expect(status.getAttribute("id")).toBe("trace-status");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(log.getAttribute("aria-labelledby")).toBe("trace-heading");
    expect(log.getAttribute("aria-describedby")).toBe("trace-status");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("aria-relevant")).toBe("additions");
    expect(log.getAttribute("aria-busy")).toBe("true");

    sources[0].dispatchEvent(new Event("open"));
    expect(status.textContent).toBe("Live · all MCP clients · newest first.");
    expect(log.getAttribute("aria-busy")).toBe("false");

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
    expect(log.textContent).toContain("failed · INVALID_INPUT");
    expect(log.textContent).toContain("HTTP 503");
    expect(log.textContent).toContain("Request body — truncated");
    expect(log.textContent).toContain("engine restarted");
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
    expect(status.textContent).toBe("Connection lost · reconnecting…");
    expect(log.getAttribute("aria-busy")).toBe("true");

    dispose();
    expect(sources[0].closed).toBe(true);
  });
});
