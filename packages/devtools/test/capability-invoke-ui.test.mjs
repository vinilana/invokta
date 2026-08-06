import { afterEach, describe, expect, it, vi } from "vitest";

const originalDescriptors = new Map(
  ["document", "fetch", "sessionStorage"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);

function installGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

class FakeClassList {
  #values = new Set();

  add(...names) {
    for (const name of names) this.#values.add(name);
  }

  remove(...names) {
    for (const name of names) this.#values.delete(name);
  }

  toggle(name, force) {
    if (force === true) this.#values.add(name);
    else if (force === false) this.#values.delete(name);
    else if (this.#values.has(name)) this.#values.delete(name);
    else this.#values.add(name);
    return this.#values.has(name);
  }

  contains(name) {
    return this.#values.has(name);
  }

  replaceFrom(value) {
    this.#values = new Set(value.split(/\s+/).filter(Boolean));
  }
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
    this.value = String(value);
  }
}

class FakeElement extends FakeNode {
  #attributes = new Map();
  childNodes = [];
  classList = new FakeClassList();
  hidden = false;
  disabled = false;
  value = "";

  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name, value) {
    this.#attributes.set(name, value);
    if (name === "class") this.classList.replaceFrom(value);
  }

  getAttribute(name) {
    return this.#attributes.get(name) ?? null;
  }

  append(...children) {
    for (const child of children) {
      const node = typeof child === "string" ? new FakeText(child) : child;
      node.parentNode = this;
      this.childNodes.push(node);
      if (this.tagName === "TEXTAREA") this.value += node.textContent;
    }
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
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

function installDocument() {
  installGlobal("document", {
    body: new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
  });
}

function walk(element) {
  return [
    element,
    ...element.childNodes.flatMap((child) =>
      child instanceof FakeElement ? walk(child) : [],
    ),
  ];
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(assertion) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    }
  }
}

const classify = {
  id: "support.classify-ticket",
  title: "Classify ticket",
  description: "Classifies a support ticket by urgency.",
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: "object",
    properties: { ticketId: { type: "string" } },
    required: ["ticketId"],
  },
  outputSchema: {
    type: "object",
    properties: { urgency: { type: "string" } },
  },
  timeoutMs: 2_000,
};

afterEach(() => {
  vi.resetModules();
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("capability discovery", () => {
  it("explains an empty capability catalog", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    installGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([])),
    );

    const { renderCapabilitiesPanel } = await import(
      "../src/ui/capabilities.js"
    );
    const container = new FakeElement("main");
    renderCapabilitiesPanel(container);

    await waitFor(() =>
      expect(container.textContent).toContain("No capabilities published."),
    );
    expect(container.textContent).toContain(
      "inspect its contract and invoke it",
    );
    const empty = walk(container).find(
      (node) => node instanceof FakeElement && node.classList.contains("empty"),
    );
    expect(empty.getAttribute("role")).toBe("status");
  });

  it("identifies choices by title and ID and exposes the selected detail", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    installGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          classify,
          {
            ...classify,
            id: "support.summarize-ticket",
            title: undefined,
            description: "Summarizes a support ticket.",
          },
        ]),
      ),
    );

    const { renderCapabilitiesPanel } = await import(
      "../src/ui/capabilities.js"
    );
    const container = new FakeElement("main");
    const dispose = renderCapabilitiesPanel(container);

    await waitFor(() =>
      expect(container.textContent).toContain("2 published capabilities"),
    );
    const elements = walk(container);
    const buttons = elements.filter(
      (node) => node instanceof FakeElement && node.tagName === "BUTTON",
    );
    const first = buttons.find((button) =>
      button.textContent.includes("support.classify-ticket"),
    );
    const second = buttons.find((button) =>
      button.textContent.includes("support.summarize-ticket"),
    );
    const detail = elements.find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "region",
    );

    expect(first.textContent).toBe("Classify ticket · support.classify-ticket");
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(first.getAttribute("aria-controls")).toBe(detail.getAttribute("id"));
    expect(detail.getAttribute("aria-labelledby")).toBe(
      first.getAttribute("id"),
    );
    expect(container.textContent).toContain("Annotations: readOnlyHint");

    second.dispatchEvent(new Event("click"));
    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(detail.getAttribute("aria-labelledby")).toBe(
      second.getAttribute("id"),
    );
    expect(detail.textContent).toContain("Summarizes a support ticket.");
    dispose();
  });
});

describe("capability invocation", () => {
  it("communicates input and response states while sending one MCP tools/call", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    const fetch = vi.fn(async (path) => {
      expect(path).toBe("/mcp");
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: '{"urgency":"high"}' }],
          structuredContent: { urgency: "high" },
        },
      });
    });
    installGlobal("fetch", fetch);

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const panel = renderInvokePanel(classify);
    const elements = walk(panel);
    const editor = elements.find(
      (node) => node instanceof FakeElement && node.tagName === "TEXTAREA",
    );
    const result = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("result"),
    );
    const invoke = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "BUTTON" &&
        node.textContent === "Send MCP request",
    );
    const feedback = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("feedback"),
    );

    expect(result.textContent).toContain("No response yet");
    expect(result.getAttribute("aria-label")).toBe("Invocation response");
    expect(editor.getAttribute("aria-describedby")).toBe(
      feedback.getAttribute("id"),
    );

    editor.value = "{";
    invoke.dispatchEvent(new Event("click"));
    expect(fetch).not.toHaveBeenCalled();
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect(feedback.textContent).toContain("valid JSON");

    editor.value = '{"ticketId":"T-123"}';
    invoke.dispatchEvent(new Event("click"));
    expect(invoke.disabled).toBe(true);
    expect(result.getAttribute("aria-busy")).toBe("true");

    await waitFor(() => expect(result.textContent).toContain('"high"'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      method: "tools/call",
      params: {
        name: "support.classify-ticket",
        arguments: { ticketId: "T-123" },
      },
    });
    expect(editor.getAttribute("aria-invalid")).toBe("false");
    expect(result.getAttribute("aria-busy")).toBe("false");
    expect(panel.textContent).toContain("Response · success");
  });

  it("distinguishes authentication failures from engine errors", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: '{"code":"FORBIDDEN","message":"Access denied."}',
              },
            ],
          },
        }),
      );
    installGlobal("fetch", fetch);

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const panel = renderInvokePanel(classify);
    const elements = walk(panel);
    const invoke = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "BUTTON" &&
        node.textContent === "Send MCP request",
    );
    const feedback = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("feedback"),
    );
    const result = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("result"),
    );

    invoke.dispatchEvent(new Event("click"));
    await waitFor(() =>
      expect(feedback.textContent).toContain(
        "Authentication failed (HTTP 401)",
      ),
    );
    expect(panel.textContent).toContain("Response · HTTP 401");

    invoke.dispatchEvent(new Event("click"));
    await waitFor(() =>
      expect(feedback.textContent).toContain("returned an engine error"),
    );
    expect(panel.textContent).toContain("Response · engine error");
    expect(result.textContent).toContain('"FORBIDDEN"');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
