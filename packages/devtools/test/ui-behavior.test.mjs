import { afterEach, describe, expect, it, vi } from "vitest";

const originalDescriptors = new Map(
  [
    "document",
    "EventSource",
    "fetch",
    "localStorage",
    "matchMedia",
    "sessionStorage",
  ].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
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
  dataset = {};
  focused = false;
  scrolledIntoView = false;
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

  focus() {
    this.focused = true;
  }

  select() {
    this.selected = true;
  }

  scrollIntoView() {
    this.scrolledIntoView = true;
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
  it("drops an unknown stored token without rotating a credential", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "invokta-devtools.tokens",
      JSON.stringify({ old: "expired" }),
    );
    storage.setItem("invokta-devtools.active", "old");
    installGlobal("sessionStorage", storage);
    const fetchMock = vi.fn(async (path, options = {}) => {
      if (path === "/api/principals" && options.method === undefined) {
        return jsonResponse([{ key: "p1", principal: { id: "local-dev" } }]);
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    installGlobal("fetch", fetchMock);

    const principals = await import("../src/ui/principals.js");
    await principals.ensureActiveToken();

    expect(principals.getActivePrincipalKey()).toBe("p1");
    expect(principals.getActiveToken()).toBeNull();
    expect(principals.getActivePrincipalStatus()).toEqual({
      key: "p1",
      principalId: "local-dev",
      hasSessionToken: false,
    });
    expect(JSON.parse(storage.getItem("invokta-devtools.tokens"))).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
  it("preserves cached panels and closes the trace stream when it is left", async () => {
    const document = {
      documentElement: new FakeElement("html"),
      head: new FakeElement("head"),
      body: new FakeElement("body"),
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    };
    const storage = new MemoryStorage();
    const themeStorage = new MemoryStorage();
    themeStorage.setItem("starlight-theme", "light");
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
    installGlobal("localStorage", themeStorage);
    installGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    installGlobal("sessionStorage", storage);
    installGlobal("EventSource", FakeEventSource);
    let doctorCalls = 0;
    let principalCalls = 0;
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
        if (path === "/api/doctor") {
          doctorCalls += 1;
          return jsonResponse({
            engineName: "fixture-engine",
            engineVersion: "1.0.0",
            findings: [],
            notes: [],
          });
        }
        if (path === "/api/principals" && options.method === undefined) {
          principalCalls += 1;
          return jsonResponse([{ key: "p1", principal: { id: "local-dev" } }]);
        }
        throw new Error(`Unexpected request: ${String(path)}`);
      }),
    );

    await import("../src/ui/app.js");
    const shell = walk(document.body).find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("app-shell"),
    );
    const brand = walk(document.body).find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("brand-lockup"),
    );
    const themeGroup = walk(document.body).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("aria-label") === "Color theme",
    );
    expect(shell).toBeDefined();
    expect(brand.textContent).toContain("invokta");
    expect(shell.textContent).not.toContain("[ local / engine ]");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(themeGroup.getAttribute("role")).toBe("radiogroup");

    const mark = walk(brand).find(
      (node) => node instanceof FakeElement && node.tagName === "SVG",
    );
    expect(mark).toBeDefined();
    const markPaths = walk(mark).filter(
      (node) => node instanceof FakeElement && node.tagName === "PATH",
    );
    const markStrokes = walk(mark).find(
      (node) => node instanceof FakeElement && node.tagName === "G",
    );
    expect(mark.getAttribute("viewBox")).toBe("0 0 51 43");
    expect(markStrokes.getAttribute("transform")).toBe("translate(-6.5,-10.5)");
    expect(markStrokes.getAttribute("stroke-width")).toBe("9");
    expect(markStrokes.getAttribute("stroke-linecap")).toBe("round");
    expect(markStrokes.getAttribute("stroke-linejoin")).toBe("round");
    expect(markPaths.map((path) => path.getAttribute("d"))).toEqual([
      "M11 15 L29 32 L11 49",
      "M36 49 H53",
    ]);
    expect(markPaths.map((path) => path.getAttribute("stroke"))).toEqual([
      "var(--accent-text)",
      "var(--ink-fg)",
    ]);
    await waitFor(() =>
      expect(shell.textContent).toContain("Act as local-dev"),
    );
    expect(shell.textContent).toContain("Connected locally");
    expect(shell.textContent).toContain("No token");
    const principalContext = walk(document.body).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("principal-context"),
    );
    expect(principalContext.getAttribute("aria-label")).toBe(
      "Act as local-dev, no session token; manage test identities",
    );
    const principalContextLabel = walk(principalContext).find(
      (node) => node instanceof FakeElement && node.tagName === "SPAN",
    );
    expect(principalContextLabel.getAttribute("role")).toBeNull();

    const buttons = walk(document.body).filter(
      (node) => node instanceof FakeElement && node.tagName === "BUTTON",
    );
    const capabilities = buttons.find(
      (button) => button.textContent === "Playground",
    );
    const trace = buttons.find((button) => button.textContent === "Activity");
    const diagnostics = buttons.find(
      (button) => button.textContent === "Diagnostics",
    );
    const testIdentities = buttons.find(
      (button) => button.textContent === "Test identities",
    );
    expect(diagnostics).toBeDefined();
    expect(testIdentities).toBeDefined();
    const darkTheme = buttons.find(
      (button) => button.getAttribute("aria-label") === "Dark",
    );
    const lightTheme = buttons.find(
      (button) => button.getAttribute("aria-label") === "Light",
    );
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
    expect(lightTheme.getAttribute("aria-checked")).toBe("true");

    const mainLandmarks = walk(document.body).filter(
      (node) => node instanceof FakeElement && node.tagName === "MAIN",
    );
    const tabButtons = buttons.filter(
      (button) => button.getAttribute("role") === "tab",
    );
    expect(mainLandmarks).toHaveLength(1);
    expect(mainLandmarks[0].getAttribute("role")).toBeNull();
    expect(
      new Set(tabButtons.map((button) => button.getAttribute("aria-controls")))
        .size,
    ).toBe(tabButtons.length);

    const capabilitiesPanel = walk(mainLandmarks[0]).find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "tabpanel",
    );
    expect(capabilities.getAttribute("aria-controls")).toBe(
      capabilitiesPanel.getAttribute("id"),
    );
    expect(capabilitiesPanel.getAttribute("aria-labelledby")).toBe(
      capabilities.id,
    );
    expect(capabilitiesPanel.classList.contains("workspace-panel")).toBe(true);
    expect(
      capabilitiesPanel.classList.contains("workspace-panel--capabilities"),
    ).toBe(true);
    await waitFor(() =>
      expect(capabilitiesPanel.textContent).toContain(
        "No capabilities published",
      ),
    );
    const draft = new FakeElement("textarea");
    draft.value = '{"preserved":true}';
    capabilitiesPanel.append(draft);

    darkTheme.dispatchEvent(new Event("click"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeStorage.getItem("starlight-theme")).toBe("dark");
    expect(darkTheme.getAttribute("aria-checked")).toBe("true");
    expect(lightTheme.getAttribute("aria-checked")).toBe("false");

    const nextTab = new Event("keydown");
    Object.defineProperties(nextTab, {
      key: { value: "ArrowRight" },
      target: { value: capabilities },
    });
    tabs.dispatchEvent(nextTab);
    expect(sources).toHaveLength(1);
    expect(trace.getAttribute("aria-selected")).toBe("true");
    expect(trace.focused).toBe(true);
    expect(trace.scrolledIntoView).toBe(true);
    expect(capabilities.getAttribute("aria-selected")).toBe("false");
    const firstTracePanel = walk(mainLandmarks[0]).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("id") === trace.getAttribute("aria-controls"),
    );
    expect(firstTracePanel.classList.contains("workspace-panel")).toBe(true);
    expect(firstTracePanel.classList.contains("workspace-panel--trace")).toBe(
      true,
    );
    capabilities.dispatchEvent(new Event("click"));

    expect(sources[0].closed).toBe(true);
    const restoredPanel = walk(mainLandmarks[0]).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("id") === capabilitiesPanel.getAttribute("id"),
    );
    expect(restoredPanel).toBe(capabilitiesPanel);
    expect(draft.value).toBe('{"preserved":true}');

    trace.dispatchEvent(new Event("click"));
    expect(sources).toHaveLength(2);
    const secondTracePanel = walk(mainLandmarks[0]).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("id") === trace.getAttribute("aria-controls"),
    );
    expect(secondTracePanel).not.toBe(firstTracePanel);
    capabilities.dispatchEvent(new Event("click"));
    expect(sources[1].closed).toBe(true);

    diagnostics.dispatchEvent(new Event("click"));
    await waitFor(() => expect(doctorCalls).toBe(1));
    capabilities.dispatchEvent(new Event("click"));
    diagnostics.dispatchEvent(new Event("click"));
    await waitFor(() => expect(doctorCalls).toBe(2));

    capabilities.dispatchEvent(new Event("click"));
    await waitFor(() => expect(principalCalls).toBe(1));
    testIdentities.dispatchEvent(new Event("click"));
    await waitFor(() => expect(principalCalls).toBe(2));
    capabilities.dispatchEvent(new Event("click"));
    testIdentities.dispatchEvent(new Event("click"));
    await waitFor(() => expect(principalCalls).toBe(3));

    capabilities.dispatchEvent(new Event("click"));
    const finalRestoredPanel = walk(mainLandmarks[0]).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("id") === capabilitiesPanel.getAttribute("id"),
    );
    expect(finalRestoredPanel).toBe(capabilitiesPanel);
    expect(draft.value).toBe('{"preserved":true}');
  });

  it("returns to the catalog filter from the slash shortcut", async () => {
    const document = {
      documentElement: new FakeElement("html"),
      head: new FakeElement("head"),
      body: new FakeElement("body"),
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    };
    class FakeEventSource extends EventTarget {
      close() {}
    }
    installGlobal("document", document);
    installGlobal("localStorage", new MemoryStorage());
    installGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    installGlobal("sessionStorage", new MemoryStorage());
    installGlobal("EventSource", FakeEventSource);
    installGlobal(
      "fetch",
      vi.fn(async (path) => {
        if (path === "/api/engine") {
          return jsonResponse({
            name: "fixture-engine",
            version: "1.0.0",
            capabilityCount: 1,
            engineHost: { host: "127.0.0.1", port: 4101 },
          });
        }
        if (path === "/api/capabilities") {
          return jsonResponse([
            {
              id: "support.classify",
              title: "Classify ticket",
              description: "Classifies a support ticket.",
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
            },
          ]);
        }
        if (path === "/api/principals") return jsonResponse([]);
        throw new Error(`Unexpected request: ${String(path)}`);
      }),
    );

    await import("../src/ui/app.js");
    await waitFor(() =>
      expect(
        walk(document.body).some(
          (node) =>
            node instanceof FakeElement &&
            node.getAttribute("id") === "capability-search",
        ),
      ).toBe(true),
    );
    const search = walk(document.body).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("id") === "capability-search",
    );
    const tabButtons = walk(document.body).filter(
      (node) => node instanceof FakeElement && node.tagName === "BUTTON",
    );
    const playground = tabButtons.find(
      (button) => button.textContent === "Playground",
    );
    const activity = tabButtons.find(
      (button) => button.textContent === "Activity",
    );

    activity.dispatchEvent(new Event("click"));
    expect(playground.getAttribute("aria-selected")).toBe("false");

    const shortcut = new Event("keydown", { cancelable: true });
    Object.defineProperties(shortcut, {
      key: { value: "/" },
      target: { value: document.body },
    });
    document.body.dispatchEvent(shortcut);

    expect(playground.getAttribute("aria-selected")).toBe("true");
    expect(search.focused).toBe(true);
    expect(search.selected).toBe(true);
    expect(shortcut.defaultPrevented).toBe(true);

    const typing = new Event("keydown", { cancelable: true });
    Object.defineProperties(typing, {
      key: { value: "/" },
      target: { value: search },
    });
    document.body.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
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
      expect(container.textContent).toContain("Couldn’t load capabilities."),
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
      "The test identity could not be deleted.",
    );
  });

  it("appends the server error code when the body carries no message", async () => {
    installGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unknown_principal" }, 404)),
    );
    const { api, ApiError } = await import("../src/ui/api.js");

    const failure = await api.removePrincipal("missing").then(
      () => null,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.message).toBe(
      "The test identity could not be deleted. (unknown_principal)",
    );
    expect(failure.code).toBe("unknown_principal");
  });

  it("propagates the server error message when present", async () => {
    installGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: "invalid_principal", message: "Principal id is taken." },
          400,
        ),
      ),
    );
    const { api, ApiError } = await import("../src/ui/api.js");

    const failure = await api.createPrincipal({ id: "local-dev" }).then(
      () => null,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.message).toBe("Principal id is taken.");
    expect(failure.code).toBe("invalid_principal");
  });

  it("sends read requests with a timeout signal", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        name: "fixture-engine",
        version: "1.0.0",
        capabilityCount: 0,
        engineHost: { host: "127.0.0.1", port: 4101 },
      }),
    );
    installGlobal("fetch", fetchMock);
    const { api } = await import("../src/ui/api.js");

    await api.engine();
    const [, options] = fetchMock.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
