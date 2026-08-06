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
  disabled = false;
  hidden = false;
  value = "";

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

function installBrowser(fetchImplementation) {
  installGlobal("document", {
    createElement: (tagName) => new FakeElement(tagName),
  });
  installGlobal("sessionStorage", new MemoryStorage());
  installGlobal("fetch", vi.fn(fetchImplementation));
}

afterEach(() => {
  vi.resetModules();
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("principals panel", () => {
  it("explains token lifecycle and exposes principal states as text", async () => {
    installBrowser(async () =>
      jsonResponse([
        { key: "p1", principal: { id: "local-dev" } },
        { key: "p2", principal: { id: "reviewer" } },
      ]),
    );
    sessionStorage.setItem(
      "invokta-devtools.tokens",
      JSON.stringify({ p1: "secret" }),
    );
    sessionStorage.setItem("invokta-devtools.active", "p1");

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);

    await waitFor(() => expect(container.textContent).toContain("Token ready"));
    expect(container.textContent).toContain("Active");
    expect(container.textContent).toContain("Inactive");
    expect(container.textContent).toContain("No token");
    expect(container.textContent).toContain(
      "Replacing a token revokes the previous token immediately.",
    );
    const row = walk(container).find(
      (node) => node.getAttribute?.("role") === "group",
    );
    expect(row.getAttribute("aria-label")).toBe("Principal local-dev");
    const status = walk(row).find(
      (node) => node.getAttribute?.("aria-live") === "polite",
    );
    expect(status).toBeDefined();
  });

  it("requires an explicit confirmation before deleting a principal", async () => {
    installBrowser(async (_path, options = {}) => {
      if (options.method === "DELETE") return new Promise(() => undefined);
      return jsonResponse([{ key: "p1", principal: { id: "local-dev" } }]);
    });

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() => expect(container.textContent).toContain("local-dev"));

    const deleteButton = walk(container).find(
      (node) => node.tagName === "BUTTON" && node.textContent === "Delete…",
    );
    deleteButton.dispatchEvent(new Event("click"));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(deleteButton.textContent).toBe("Confirm delete");
    expect(container.textContent).toContain(
      "Its token will stop working immediately.",
    );

    deleteButton.dispatchEvent(new Event("click"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/principals",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
