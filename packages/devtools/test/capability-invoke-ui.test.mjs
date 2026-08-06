import { afterEach, describe, expect, it, vi } from "vitest";

const originalDescriptors = new Map(
  ["document", "fetch", "navigator", "sessionStorage"].map((name) => [
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
  focusCalls = 0;
  scrollTop = 0;
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

  focus() {
    this.focusCalls += 1;
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

class FakeDocument extends EventTarget {
  body = new FakeElement("body");

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

function installDocument() {
  installGlobal("document", new FakeDocument());
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
  vi.useRealTimers();
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
    expect(container.textContent).toContain("inspect its contract and test it");
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
      expect(container.textContent).toContain("2 of 2 capabilities"),
    );
    const elements = walk(container);
    const heading = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-sidebar-heading"),
    );
    const list = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-list"),
    );
    const buttons = elements.filter(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-choice"),
    );
    const first = buttons.find((button) =>
      button.textContent.includes("support.classify-ticket"),
    );
    const second = buttons.find((button) =>
      button.textContent.includes("support.summarize-ticket"),
    );
    const detail = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-pane"),
    );

    const title = walk(first).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-choice-title"),
    );
    const publicId = walk(first).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-choice-id"),
    );

    expect(heading.tagName).toBe("H2");
    expect(heading.textContent).toBe("Capabilities");
    expect(container.textContent).not.toContain("[ engine / capabilities ]");
    expect(container.textContent).not.toContain("[ capability / detail ]");
    expect(title.textContent).toBe("Classify ticket");
    expect(publicId.textContent).toBe("support.classify-ticket");
    expect(title.parentNode).toBe(first);
    expect(publicId.parentNode).toBe(first);
    expect(list.getAttribute("role")).toBe("tablist");
    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    expect(first.getAttribute("role")).toBe("tab");
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(first.getAttribute("tabindex")).toBe("0");
    expect(first.getAttribute("aria-controls")).toBe(detail.getAttribute("id"));
    expect(detail.getAttribute("role")).toBe("tabpanel");
    expect(detail.getAttribute("aria-labelledby")).toBe(
      first.getAttribute("id"),
    );
    expect(container.textContent).not.toContain("Annotations:");
    expect(container.textContent).toContain("readOnlyHint");
    expect(container.textContent).not.toContain(
      "Edit the generated arguments, then send a tools/call request through engine.invoke.",
    );
    expect(container.textContent).toContain("tools/call → engine.invoke");
    const overview = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-overview"),
    );
    const capabilityMeta = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("aria-label") === "Capability metadata",
    );
    const schemaGrid = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("schema-grid"),
    );
    const schemaCards = elements.filter(
      (node) =>
        node instanceof FakeElement && node.classList.contains("schema-card"),
    );
    expect(overview).toBeDefined();
    expect(capabilityMeta.textContent).toContain("readOnlyHint");
    expect(capabilityMeta.textContent).toContain("2,000 ms timeout");
    expect(schemaGrid).toBeDefined();
    expect(schemaCards).toHaveLength(2);
    expect(schemaCards[0].textContent).toContain("Input schema");
    expect(schemaCards[0].textContent).toContain("ticketIdstringrequired");
    expect(schemaCards[0].textContent).toContain("1 required");
    expect(schemaCards[1].textContent).toContain("Output schema");
    expect(schemaCards[1].textContent).toContain("urgencystringoptional");
    expect(schemaCards[1].textContent).not.toContain("required");
    expect(
      schemaCards.map(
        (card) =>
          walk(card)
            .find(
              (node) =>
                node instanceof FakeElement &&
                node.classList.contains("copy-button"),
            )
            ?.getAttribute("aria-label") ?? null,
      ),
    ).toEqual(["Copy input schema", "Copy output schema"]);
    expect(
      elements.filter(
        (node) =>
          node instanceof FakeElement &&
          node.tagName === "SUMMARY" &&
          node.textContent === "Raw JSON Schema",
      ),
    ).toHaveLength(2);

    detail.scrollTop = 320;
    const arrowDown = new Event("keydown", { cancelable: true });
    Object.defineProperty(arrowDown, "key", { value: "ArrowDown" });
    first.dispatchEvent(arrowDown);
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(first.getAttribute("aria-selected")).toBe("false");
    expect(first.getAttribute("tabindex")).toBe("-1");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("tabindex")).toBe("0");
    expect(second.focusCalls).toBe(1);
    expect(detail.scrollTop).toBe(0);
    expect(detail.getAttribute("aria-labelledby")).toBe(
      second.getAttribute("id"),
    );
    expect(
      walk(second).find(
        (node) =>
          node instanceof FakeElement &&
          node.classList.contains("capability-choice-title"),
      ).textContent,
    ).toBe("Untitled capability");
    expect(detail.textContent).toContain("Untitled capability");
    expect(detail.textContent).toContain("Summarizes a support ticket.");
    dispose();
  });

  it("filters by title, ID, or description and keeps count and selection accurate", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    installGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          classify,
          {
            ...classify,
            id: "support.create-brief",
            title: "Create brief",
            description: "Produces a concise overview for an account.",
          },
        ]),
      ),
    );

    const { renderCapabilitiesPanel } = await import(
      "../src/ui/capabilities.js"
    );
    const container = new FakeElement("main");
    renderCapabilitiesPanel(container);

    await waitFor(() =>
      expect(container.textContent).toContain("2 of 2 capabilities"),
    );
    const elements = walk(container);
    const search = elements.find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("type") === "search",
    );
    const count = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-count"),
    );
    const filterEmpty = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-filter-empty"),
    );
    const choices = elements.filter(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-choice"),
    );
    const first = choices[0];
    const second = choices[1];

    expect(search.getAttribute("aria-controls")).toBe(
      elements
        .find(
          (node) =>
            node instanceof FakeElement &&
            node.classList.contains("capability-list"),
        )
        .getAttribute("id"),
    );
    expect(count.getAttribute("role")).toBe("status");
    expect(filterEmpty.hidden).toBe(true);

    search.value = "concise overview";
    search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("1 of 2 capabilities");
    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(false);
    // The filter no longer hijacks the open detail: first stays selected.
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-selected")).toBe("false");
    expect(container.textContent).toContain(
      "Classifies a support ticket by urgency.",
    );

    search.value = "does-not-exist";
    search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("0 of 2 capabilities");
    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(true);
    expect(filterEmpty.hidden).toBe(false);
    expect(filterEmpty.textContent).toContain("No capabilities match");
    expect(first.getAttribute("aria-selected")).toBe("true");
    const detail = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-pane"),
    );
    const editedRequest = walk(detail).find(
      (node) => node instanceof FakeElement && node.tagName === "TEXTAREA",
    );
    editedRequest.value = '{"account":"preserved"}';

    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("2 of 2 capabilities");
    expect(first.hidden).toBe(false);
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(
      walk(detail).find(
        (node) => node instanceof FakeElement && node.tagName === "TEXTAREA",
      ).value,
    ).toBe('{"account":"preserved"}');

    second.dispatchEvent(new Event("click"));
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain(
      "Produces a concise overview for an account.",
    );

    search.value = "CLASSIFY TICKET";
    search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("1 of 2 capabilities");
    expect(second.hidden).toBe(true);
    // The selected capability stays open even though the filter hides it.
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain(
      "Produces a concise overview for an account.",
    );
  });

  it("offers a retry when the catalog fails to load", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    let calls = 0;
    installGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: "internal_error" }, 500);
        return jsonResponse([classify]);
      }),
    );

    const { renderCapabilitiesPanel } = await import(
      "../src/ui/capabilities.js"
    );
    const container = new FakeElement("main");
    renderCapabilitiesPanel(container);

    await waitFor(() =>
      expect(container.textContent).toContain("Couldn’t load capabilities."),
    );
    const retry = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-retry"),
    );
    expect(retry).toBeDefined();

    retry.dispatchEvent(new Event("click"));
    await waitFor(() =>
      expect(container.textContent).toContain("Classify ticket"),
    );
    expect(calls).toBe(2);
  });

  it("selects a capability handed over through invokta:select-capability", async () => {
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
            title: "Summarize ticket",
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
      expect(container.textContent).toContain("2 of 2 capabilities"),
    );
    const detail = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-pane"),
    );
    expect(detail.textContent).toContain("Classifies a support ticket");

    const handoff = new Event("invokta:select-capability");
    Object.defineProperty(handoff, "detail", {
      value: { id: "support.summarize-ticket" },
    });
    document.dispatchEvent(handoff);

    const second = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("capability-choice") &&
        node.textContent.includes("support.summarize-ticket"),
    );
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(detail.textContent).toContain("Summarizes a support ticket.");

    dispose();
    // After dispose the handoff listener is gone.
    const ignored = new Event("invokta:select-capability");
    Object.defineProperty(ignored, "detail", {
      value: { id: "support.classify-ticket" },
    });
    document.dispatchEvent(ignored);
    expect(second.getAttribute("aria-selected")).toBe("true");
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
        node.textContent === "Invoke capability",
    );
    const format = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "BUTTON" &&
        node.textContent === "Format JSON",
    );
    const feedback = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("feedback"),
    );

    expect(result.textContent).toContain("Invoke the capability");
    expect(result.getAttribute("aria-label")).toBe("Capability result");
    expect(editor.getAttribute("aria-describedby")).toBe(
      feedback.getAttribute("id"),
    );
    expect(
      elements.some(
        (node) =>
          node instanceof FakeElement && node.classList.contains("window-dots"),
      ),
    ).toBe(false);
    expect(
      elements.find(
        (node) =>
          node instanceof FakeElement &&
          node.classList.contains("invoke-workspace"),
      ),
    ).toBeDefined();
    expect(panel.textContent).toContain("Raw MCP exchange");

    editor.value = "{";
    invoke.dispatchEvent(new Event("click"));
    expect(fetch).not.toHaveBeenCalled();
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect(feedback.textContent).toContain("valid JSON");
    // The SyntaxError detail (position info) follows the generic guidance.
    expect(feedback.textContent).toMatch(
      /Enter valid JSON before invoking\. .+/,
    );

    editor.value = '{"ticketId":"T-123"}';
    format.dispatchEvent(new Event("click"));
    expect(editor.value).toContain('\n  "ticketId": "T-123"\n');
    const shortcut = new Event("keydown", { cancelable: true });
    Object.defineProperties(shortcut, {
      key: { value: "Enter" },
      ctrlKey: { value: true },
    });
    editor.dispatchEvent(shortcut);
    expect(invoke.getAttribute("aria-disabled")).toBe("true");
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
    expect(invoke.getAttribute("aria-disabled")).toBe("false");
    expect(invoke.focusCalls).toBe(0);
    expect(panel.textContent).toContain("Result · success");

    const resultState = walk(panel).find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "SPAN" &&
        node.textContent.startsWith("Result · success"),
    );
    expect(resultState.textContent).toMatch(
      /^Result · success · \d+\.\d+ (?:ms|s)$/,
    );

    const copyButtons = walk(panel).filter(
      (node) =>
        node instanceof FakeElement && node.classList.contains("copy-button"),
    );
    expect(
      copyButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Copy arguments",
      "Copy curl command",
      "Copy capability result",
      "Copy raw MCP request",
      "Copy raw MCP response",
    ]);
    expect(panel.textContent).toContain("invokes from the editor");
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
        node.textContent === "Invoke capability",
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
    expect(feedback.textContent).toContain("In Test identities");
    expect(panel.textContent).toContain("Result · HTTP 401");

    invoke.dispatchEvent(new Event("click"));
    await waitFor(() =>
      expect(feedback.textContent).toContain("returned an engine error"),
    );
    expect(panel.textContent).toContain("Result · engine error");
    expect(result.textContent).toContain('"FORBIDDEN"');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("copies the exact request as a curl command", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    const writeText = vi.fn(async () => undefined);
    installGlobal("navigator", { clipboard: { writeText } });
    installGlobal("fetch", vi.fn());

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const panel = renderInvokePanel(classify);
    const editor = walk(panel).find(
      (node) => node instanceof FakeElement && node.tagName === "TEXTAREA",
    );
    const curl = walk(panel).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("aria-label") === "Copy curl command",
    );
    expect(curl).toBeDefined();

    editor.value = '{"ticketId":"T-9"}';
    curl.dispatchEvent(new Event("click"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const command = writeText.mock.calls[0][0];
    expect(command).toContain("curl -X POST /mcp");
    expect(command).toContain('-H "content-type: application/json"');
    expect(command).toContain(
      '-H "accept: application/json, text/event-stream"',
    );
    expect(command).not.toContain("authorization");
    expect(command).toContain('"method": "tools/call"');
    expect(command).toContain('"name": "support.classify-ticket"');
    expect(command).toContain('"ticketId": "T-9"');
  });

  it("includes the authorization header in the curl command when a token is active", async () => {
    installDocument();
    const storage = new MemoryStorage();
    storage.setItem(
      "invokta-devtools.tokens",
      JSON.stringify({ p1: "tok-123" }),
    );
    storage.setItem("invokta-devtools.active", "p1");
    installGlobal("sessionStorage", storage);
    const writeText = vi.fn(async () => undefined);
    installGlobal("navigator", { clipboard: { writeText } });
    installGlobal("fetch", vi.fn());

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const panel = renderInvokePanel(classify);
    const curl = walk(panel).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("aria-label") === "Copy curl command",
    );

    curl.dispatchEvent(new Event("click"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain(
      '-H "authorization: Bearer tok-123"',
    );
  });

  it("checks required fields, primitive types, and enums before invoking", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    const fetch = vi.fn();
    installGlobal("fetch", fetch);

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const panel = renderInvokePanel({
      ...classify,
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          priority: { type: "integer" },
          urgency: { type: "string", enum: ["low", "high"] },
        },
        required: ["ticketId"],
      },
    });
    const elements = walk(panel);
    const editor = elements.find(
      (node) => node instanceof FakeElement && node.tagName === "TEXTAREA",
    );
    const invoke = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "BUTTON" &&
        node.textContent === "Invoke capability",
    );
    const feedback = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("feedback"),
    );

    editor.value = "{}";
    invoke.dispatchEvent(new Event("click"));
    expect(feedback.textContent).toBe('"ticketId" is required.');

    editor.value = '{"ticketId":42}';
    invoke.dispatchEvent(new Event("click"));
    expect(feedback.textContent).toBe('"ticketId" must be a string.');

    editor.value = '{"ticketId":"T-1","priority":"high"}';
    invoke.dispatchEvent(new Event("click"));
    expect(feedback.textContent).toBe('"priority" must be an integer.');

    editor.value = '{"ticketId":"T-1","urgency":"medium"}';
    invoke.dispatchEvent(new Event("click"));
    expect(feedback.textContent).toBe(
      '"urgency" must be one of the allowed values.',
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(editor.getAttribute("aria-invalid")).toBe("true");
  });

  it("cancels a pending invocation", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    installGlobal(
      "fetch",
      vi.fn(
        (_path, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }),
      ),
    );

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const panel = renderInvokePanel(classify);
    const elements = walk(panel);
    const invoke = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "BUTTON" &&
        node.textContent === "Invoke capability",
    );
    const cancel = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("invoke-cancel"),
    );
    const feedback = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("feedback"),
    );
    expect(cancel.hidden).toBe(true);

    invoke.dispatchEvent(new Event("click"));
    expect(cancel.hidden).toBe(false);
    expect(invoke.getAttribute("aria-disabled")).toBe("true");

    cancel.dispatchEvent(new Event("click"));
    await waitFor(() =>
      expect(feedback.textContent).toContain("Invocation cancelled."),
    );
    expect(panel.textContent).toContain("Result · cancelled");
    expect(cancel.hidden).toBe(true);
    expect(invoke.getAttribute("aria-disabled")).toBe("false");
  });

  it("times out a stuck invocation using the announced timeout plus slack", async () => {
    vi.useFakeTimers();
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    installGlobal(
      "fetch",
      vi.fn(
        (_path, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }),
      ),
    );

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    // classify announces timeoutMs: 2_000, so the client gives up at 4 s.
    const panel = renderInvokePanel(classify);
    const elements = walk(panel);
    const invoke = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "BUTTON" &&
        node.textContent === "Invoke capability",
    );
    const feedback = elements.find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("feedback"),
    );

    invoke.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.resolve();

    expect(feedback.textContent).toBe(
      "No response within 4 s — the capability may be stuck.",
    );
    expect(panel.textContent).toContain("Result · timeout");
    expect(invoke.getAttribute("aria-disabled")).toBe("false");
  });

  it("persists the editor draft per capability and restores it", async () => {
    installDocument();
    const storage = new MemoryStorage();
    installGlobal("sessionStorage", storage);
    installGlobal("fetch", vi.fn());

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const first = renderInvokePanel(classify);
    const firstEditor = walk(first).find(
      (node) => node instanceof FakeElement && node.tagName === "TEXTAREA",
    );
    firstEditor.value = '{"ticketId":"draft-1"}';
    firstEditor.dispatchEvent(new Event("input"));
    expect(
      storage.getItem("invokta-devtools:draft:support.classify-ticket"),
    ).toBe('{"ticketId":"draft-1"}');

    const second = renderInvokePanel(classify);
    const elements = walk(second);
    const secondEditor = elements.find(
      (node) => node instanceof FakeElement && node.tagName === "TEXTAREA",
    );
    expect(secondEditor.value).toBe('{"ticketId":"draft-1"}');

    // Reset example reseeds the editor and clears the persisted draft.
    const reset = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "BUTTON" &&
        node.textContent === "Reset example",
    );
    reset.dispatchEvent(new Event("click"));
    expect(
      storage.getItem("invokta-devtools:draft:support.classify-ticket"),
    ).toBeNull();
    expect(secondEditor.value).toContain('"ticketId": ""');
  });

  it("prefers a prefill handoff over the persisted draft and consumes it", async () => {
    installDocument();
    const storage = new MemoryStorage();
    storage.setItem(
      "invokta-devtools:draft:support.classify-ticket",
      '{"ticketId":"draft"}',
    );
    storage.setItem(
      "invokta-devtools:prefill:support.classify-ticket",
      '{"ticketId":"from-trace"}',
    );
    installGlobal("sessionStorage", storage);
    installGlobal("fetch", vi.fn());

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const panel = renderInvokePanel(classify);
    const editor = walk(panel).find(
      (node) => node instanceof FakeElement && node.tagName === "TEXTAREA",
    );

    expect(editor.value).toBe('{"ticketId":"from-trace"}');
    expect(
      storage.getItem("invokta-devtools:prefill:support.classify-ticket"),
    ).toBeNull();
    expect(
      storage.getItem("invokta-devtools:draft:support.classify-ticket"),
    ).toBe('{"ticketId":"draft"}');
  });

  it("keeps the HTTP status out of the copied raw response", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    const writeText = vi.fn(async () => undefined);
    installGlobal("navigator", { clipboard: { writeText } });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: { ok: true } },
    });
    installGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { renderInvokePanel } = await import("../src/ui/invoke-panel.js");
    const panel = renderInvokePanel(classify);
    const elements = walk(panel);
    const invoke = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "BUTTON" &&
        node.textContent === "Invoke capability",
    );

    invoke.dispatchEvent(new Event("click"));
    await waitFor(() =>
      expect(panel.textContent).toContain("Result · success"),
    );

    const rawResponse = elements.find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("aria-label") === "Raw MCP response body",
    );
    // The status is still shown, but outside the copyable body.
    expect(panel.textContent).toContain("HTTP 200");
    expect(rawResponse.textContent).toBe(body);

    const copy = walk(panel).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("aria-label") === "Copy raw MCP response",
    );
    copy.dispatchEvent(new Event("click"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toBe(body);
  });
});

describe("schema view", () => {
  it("renders nested object properties, array items, and oneOf branches", async () => {
    installDocument();
    installGlobal("sessionStorage", new MemoryStorage());
    installGlobal("fetch", vi.fn());

    const { renderSchemaView } = await import("../src/ui/schema-view.js");
    const view = renderSchemaView("Input", {
      type: "object",
      properties: {
        ticket: {
          type: "object",
          properties: {
            id: { type: "string" },
            channel: {
              oneOf: [
                { type: "string", title: "Named channel" },
                { type: "integer" },
              ],
            },
          },
          required: ["id"],
        },
        tags: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" } },
          },
        },
      },
      required: ["ticket"],
    });

    expect(view.textContent).toContain("ticketobjectrequired");
    expect(view.textContent).toContain("idstringrequired");
    expect(view.textContent).toContain("One of");
    expect(view.textContent).toContain("Named channel");
    expect(view.textContent).toContain("Option 2");
    expect(view.textContent).toContain("Each item");
    expect(view.textContent).toContain("labelstringoptional");
    const nested = walk(view).filter(
      (node) =>
        node instanceof FakeElement && node.classList.contains("schema-nested"),
    );
    expect(nested.length).toBeGreaterThan(0);
  });
});
