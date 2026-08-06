import { afterEach, describe, expect, it, vi } from "vitest";

const originalDescriptors = new Map(
  ["document", "EventSource", "fetch", "sessionStorage"].map((name) => [
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
    this.value = value;
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
    }
  }

  prepend(...children) {
    for (const child of children.reverse()) {
      const node = typeof child === "string" ? new FakeText(child) : child;
      node.parentNode = this;
      this.childNodes.unshift(node);
    }
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
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

afterEach(() => {
  vi.resetModules();
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("principal browser session", () => {
  it("replaces a stored token whose principal no longer exists", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "invokta-devtools.tokens",
      JSON.stringify({ old: "expired" }),
    );
    storage.setItem("invokta-devtools.active", "old");
    installGlobal("sessionStorage", storage);
    installGlobal(
      "fetch",
      vi.fn(async (path, options = {}) => {
        if (path === "/api/principals" && options.method === undefined) {
          return jsonResponse([{ key: "p1", principal: { id: "local-dev" } }]);
        }
        if (path === "/api/principals" && options.method === "POST") {
          return jsonResponse({
            key: "p1",
            token: "fresh",
            principal: { id: "local-dev" },
          });
        }
        throw new Error(`Unexpected request: ${String(path)}`);
      }),
    );

    const principals = await import("../src/ui/principals.js");
    await principals.ensureActiveToken();

    expect(principals.getActivePrincipalKey()).toBe("p1");
    expect(principals.getActiveToken()).toBe("fresh");
    expect(JSON.parse(storage.getItem("invokta-devtools.tokens"))).toEqual({
      p1: "fresh",
    });
  });

  it("loads when session storage is unavailable", async () => {
    installGlobal("sessionStorage", {
      getItem() {
        throw new Error("storage disabled");
      },
      setItem() {
        throw new Error("storage disabled");
      },
      removeItem() {
        throw new Error("storage disabled");
      },
    });

    await expect(import("../src/ui/principals.js")).resolves.toBeDefined();
  });
});

describe("application tabs", () => {
  it("closes the trace stream when the user leaves the Trace tab", async () => {
    const document = {
      head: new FakeElement("head"),
      body: new FakeElement("body"),
      createElement: (tagName) => new FakeElement(tagName),
    };
    const storage = new MemoryStorage();
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
    installGlobal("document", document);
    installGlobal("sessionStorage", storage);
    installGlobal("EventSource", FakeEventSource);
    installGlobal(
      "fetch",
      vi.fn(async (path, options = {}) => {
        if (path === "/api/engine") {
          return jsonResponse({
            name: "fixture-engine",
            version: "1.0.0",
            capabilityCount: 0,
            engineHost: { host: "127.0.0.1", port: 4101 },
          });
        }
        if (path === "/api/capabilities") return jsonResponse([]);
        if (path === "/api/principals" && options.method === undefined) {
          return new Promise(() => undefined);
        }
        throw new Error(`Unexpected request: ${String(path)}`);
      }),
    );

    await import("../src/ui/app.js");
    const buttons = walk(document.body).filter(
      (node) => node instanceof FakeElement && node.tagName === "BUTTON",
    );
    const capabilities = buttons.find(
      (button) => button.textContent === "Capabilities",
    );
    const trace = buttons.find((button) => button.textContent === "Trace");
    await waitFor(() =>
      expect(capabilities.classList.contains("selected")).toBe(true),
    );

    const tabs = walk(document.body).find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "NAV" &&
        node.classList.contains("tabs"),
    );
    expect(tabs.getAttribute("role")).toBe("tablist");
    expect(capabilities.getAttribute("role")).toBe("tab");

    trace.dispatchEvent(new Event("click"));
    expect(sources).toHaveLength(1);
    expect(trace.getAttribute("aria-selected")).toBe("true");
    expect(capabilities.getAttribute("aria-selected")).toBe("false");
    capabilities.dispatchEvent(new Event("click"));

    expect(sources[0].closed).toBe(true);
  });

  it("deduplicates trace entries replayed after a reconnect", async () => {
    const document = {
      head: new FakeElement("head"),
      body: new FakeElement("body"),
      createElement: (tagName) => new FakeElement(tagName),
    };
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
    installGlobal("document", document);
    installGlobal("EventSource", FakeEventSource);

    const { renderTracePanel } = await import("../src/ui/trace.js");
    const container = new FakeElement("main");
    const dispose = renderTracePanel(container);
    const entry = JSON.stringify({
      kind: "notice",
      id: 1,
      at: "2026-08-06T12:00:00.000Z",
      notice: "engine-restarted",
    });
    for (let count = 0; count < 2; count += 1) {
      const event = new Event("trace");
      Object.defineProperty(event, "data", { value: entry });
      sources[0].dispatchEvent(event);
    }

    const list = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("trace-list"),
    );
    expect(list.childElementCount).toBe(1);

    dispose();
    expect(sources[0].closed).toBe(true);
  });

  it("shows a useful error when capabilities cannot be loaded", async () => {
    const document = {
      head: new FakeElement("head"),
      body: new FakeElement("body"),
      createElement: (tagName) => new FakeElement(tagName),
    };
    installGlobal("document", document);
    installGlobal("sessionStorage", new MemoryStorage());
    installGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "internal_error" }, 500)),
    );

    const { renderCapabilitiesPanel } = await import(
      "../src/ui/capabilities.js"
    );
    const container = new FakeElement("main");
    const dispose = renderCapabilitiesPanel(container);

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Capabilities could not be loaded.",
      ),
    );
    dispose();
  });
});

describe("browser API failures", () => {
  it("rejects a failed principal deletion", async () => {
    installGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unknown_principal" }, 404)),
    );
    const { api } = await import("../src/ui/api.js");

    await expect(api.removePrincipal("missing")).rejects.toThrow(
      "The principal could not be deleted.",
    );
  });
});
