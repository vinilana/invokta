import { afterEach, describe, expect, it, vi } from "vitest";

const originalDescriptors = new Map(
  ["document", "localStorage", "matchMedia"].map((name) => [
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

class FakeElement extends EventTarget {
  #attributes = new Map();
  childNodes = [];
  dataset = {};
  focused = false;
  #classNames = new Set();
  classList = {
    add: (name) => this.#classNames.add(name),
    remove: (name) => this.#classNames.delete(name),
    contains: (name) => this.#classNames.has(name),
  };

  constructor(tagName = "div") {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name, value) {
    this.#attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.#attributes.get(name) ?? null;
  }

  append(...children) {
    this.childNodes.push(...children);
  }

  replaceChildren(...children) {
    this.childNodes = [...children];
  }

  querySelector(selector) {
    const className = selector.replace(".", "");
    return (
      walk(this).find((element) =>
        element.getAttribute("class")?.split(" ").includes(className),
      ) ?? null
    );
  }

  focus() {
    this.focused = true;
  }

  get ownerDocument() {
    return globalThis.document;
  }

  get textContent() {
    return this.childNodes
      .map((child) =>
        child instanceof FakeElement ? child.textContent : child,
      )
      .join("");
  }
}

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
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

function installDocument() {
  const documentElement = new FakeElement("html");
  const body = new FakeElement("body");
  installGlobal("document", {
    documentElement,
    body,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
  });
  installGlobal("localStorage", new MemoryStorage());
  installGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  return { documentElement, body };
}

afterEach(() => {
  vi.resetModules();
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("workbench chooser page", () => {
  it("renders one link per workbench and focuses the first", async () => {
    // Imported before the document exists, so the module's own boot stays out
    // of the way and the mount under test is the only one.
    const { mountChooserApp } = await import("../src/ui/chooser-app.js");
    const { body } = installDocument();

    const handle = mountChooserApp(body);
    const choices = walk(body).filter((element) =>
      element.getAttribute("class")?.includes("att-choice"),
    );
    const links = choices.filter((element) => element.tagName === "A");

    expect(links.map((link) => link.getAttribute("href"))).toStrictEqual([
      "/mcp",
      "/cli",
    ]);
    expect(
      links.map((link) => link.getAttribute("data-workbench")),
    ).toStrictEqual(["mcp", "cli"]);
    expect(links[0].focused).toBe(true);
    expect(links[0].textContent).toContain("MCP workbench");
    expect(links[1].textContent).toContain("CLI workbench");
    expect(body.classList.contains("attached-mode")).toBe(true);

    handle.destroy();
    expect(body.childNodes).toHaveLength(0);
    expect(body.classList.contains("attached-mode")).toBe(false);
  });

  it("leads back to the chooser from inside a workbench", async () => {
    const chrome = await import("../src/ui/workbench-chrome.js");
    installDocument();

    const nav = chrome.createWorkbenchSwitch("cli");
    const links = walk(nav).filter((element) => element.tagName === "A");

    expect(links.map((link) => link.getAttribute("href"))).toStrictEqual([
      "/",
      "/mcp",
      "/cli",
    ]);
    expect(links[0].getAttribute("aria-label")).toBe("All workbenches");
    expect(links[1].getAttribute("aria-current")).toBeNull();
    expect(links[2].getAttribute("aria-current")).toBe("page");
  });

  it("offers the chooser and the other workbench from an idle workbench", async () => {
    const chrome = await import("../src/ui/workbench-chrome.js");
    installDocument();

    const orientation = chrome.createWorkbenchOrientation("mcp");
    const links = walk(orientation).filter(
      (element) => element.tagName === "A",
    );

    expect(links.map((link) => link.getAttribute("href"))).toStrictEqual([
      "/",
      "/cli",
    ]);
    expect(links[0].textContent).toContain("All workbenches");
    expect(links[1].textContent).toContain("CLI workbench");
    // A single-workbench server has neither destination.
    expect(chrome.createWorkbenchOrientation(undefined)).toBeUndefined();
  });

  it("names the workspace path the workbenches do not cover", async () => {
    const { mountChooserApp } = await import("../src/ui/chooser-app.js");
    const { body } = installDocument();

    mountChooserApp(body);

    expect(body.textContent).toContain("Choose a workbench");
    expect(body.textContent).toContain("invokta-devtools serve dist/engine.js");
  });
});
