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

  setAttribute(name, value) {
    this.#attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.#attributes.get(name) ?? null;
  }

  append(...children) {
    this.childNodes.push(...children);
  }

  focus() {
    this.focused = true;
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

class ThemeMediaQuery extends EventTarget {
  matches = false;
}

function walk(element) {
  return [
    element,
    ...element.childNodes.flatMap((child) =>
      child instanceof FakeElement ? walk(child) : [],
    ),
  ];
}

function keydown(element, key) {
  const event = new Event("keydown");
  Object.defineProperty(event, "key", { value: key });
  element.dispatchEvent(event);
}

afterEach(() => {
  vi.resetModules();
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("color theme control", () => {
  it("supports roving keyboard selection and follows system changes in Auto", async () => {
    const documentElement = new FakeElement();
    installGlobal("document", {
      documentElement,
      createElement: () => new FakeElement(),
    });
    const storage = new MemoryStorage();
    storage.setItem("starlight-theme", "light");
    installGlobal("localStorage", storage);
    const media = new ThemeMediaQuery();
    installGlobal("matchMedia", () => media);

    const { createThemeToggle } = await import("../src/ui/theme.js");
    const group = createThemeToggle();
    const buttons = walk(group).filter(
      (element) => element.getAttribute("role") === "radio",
    );
    const auto = buttons.find(
      (button) => button.getAttribute("aria-label") === "Auto",
    );
    const dark = buttons.find(
      (button) => button.getAttribute("aria-label") === "Dark",
    );

    expect(documentElement.dataset.theme).toBe("light");
    keydown(group, "ArrowRight");
    expect(storage.getItem("starlight-theme")).toBe("auto");
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(auto.focused).toBe(true);
    expect(documentElement.dataset.theme).toBe("dark");

    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(documentElement.dataset.theme).toBe("light");

    keydown(group, "Home");
    expect(storage.getItem("starlight-theme")).toBe("dark");
    expect(dark.focused).toBe(true);
    keydown(group, "ArrowLeft");
    expect(storage.getItem("starlight-theme")).toBe("auto");
  });

  it("keeps working in memory when browser storage is unavailable", async () => {
    const documentElement = new FakeElement();
    installGlobal("document", {
      documentElement,
      createElement: () => new FakeElement(),
    });
    installGlobal("localStorage", {
      getItem() {
        throw new Error("storage disabled");
      },
      setItem() {
        throw new Error("storage disabled");
      },
    });
    installGlobal("matchMedia", () => new ThemeMediaQuery());

    const { createThemeToggle } = await import("../src/ui/theme.js");
    const group = createThemeToggle();
    const light = walk(group).find(
      (element) => element.getAttribute("aria-label") === "Light",
    );

    expect(documentElement.dataset.theme).toBe("dark");
    light.dispatchEvent(new Event("click"));
    expect(documentElement.dataset.theme).toBe("light");
  });
});
