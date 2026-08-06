import { afterEach, describe, expect, it, vi } from "vitest";

const originalDescriptors = new Map(
  ["document", "navigator"].map((name) => [
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

class FakeNode extends EventTarget {
  parentNode = null;
}

class FakeText extends FakeNode {
  constructor(value) {
    super();
    this.value = value;
  }

  get textContent() {
    return this.value;
  }
}

class FakeElement extends FakeNode {
  #attributes = new Map();
  childNodes = [];
  value = "";
  selected = false;

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

  select() {
    this.selected = true;
  }

  remove() {
    if (this.parentNode === null) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index !== -1) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
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
    createElement: (tagName) => new FakeElement(tagName),
  });
}

function click(button) {
  button.dispatchEvent(new Event("click"));
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("copy control", () => {
  it("copies the current text and restores its resting label", async () => {
    vi.useFakeTimers();
    installDocument();
    const writeText = vi.fn(async () => undefined);
    installGlobal("navigator", { clipboard: { writeText } });

    const { createCopyButton } = await import("../src/ui/clipboard.js");
    let payload = "first";
    const button = createCopyButton("capability result", () => payload);

    expect(button.getAttribute("aria-label")).toBe("Copy capability result");
    expect(button.getAttribute("data-state")).toBe("idle");
    expect(button.textContent).toBe("Copy");

    click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith("first");
    expect(button.textContent).toBe("Copied");
    expect(button.getAttribute("data-state")).toBe("copied");

    await vi.advanceTimersByTimeAsync(1_600);
    expect(button.textContent).toBe("Copy");
    expect(button.getAttribute("data-state")).toBe("idle");

    payload = "second";
    click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenLastCalledWith("second");
  });

  it("reports a rejected write without throwing", async () => {
    vi.useFakeTimers();
    installDocument();
    installGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });

    const { createCopyButton } = await import("../src/ui/clipboard.js");
    const button = createCopyButton("raw response", () => "body");

    click(button);
    await vi.advanceTimersByTimeAsync(0);
    expect(button.textContent).toBe("Failed");
    expect(button.getAttribute("data-state")).toBe("failed");
  });

  it("reports an unavailable clipboard and an empty source", async () => {
    vi.useFakeTimers();
    installDocument();
    const writeText = vi.fn(async () => undefined);
    installGlobal("navigator", { clipboard: { writeText } });

    const { createCopyButton } = await import("../src/ui/clipboard.js");
    const empty = createCopyButton("capability result", () => "");
    click(empty);
    expect(empty.textContent).toBe("Nothing yet");
    expect(writeText).not.toHaveBeenCalled();

    installGlobal("navigator", {});
    const unsupported = createCopyButton("input schema", () => "{}");
    click(unsupported);
    expect(unsupported.textContent).toBe("Unavailable");
    expect(unsupported.getAttribute("data-state")).toBe("failed");
  });

  it("falls back to a hidden textarea and execCommand without the async clipboard", async () => {
    vi.useFakeTimers();
    const body = new FakeElement("body");
    const execCommand = vi.fn(() => true);
    installGlobal("document", {
      body,
      createElement: (tagName) => new FakeElement(tagName),
      execCommand,
    });
    installGlobal("navigator", {});

    const { createCopyButton } = await import("../src/ui/clipboard.js");
    const button = createCopyButton("raw response", () => "payload");

    click(button);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(button.textContent).toBe("Copied");
    expect(button.getAttribute("data-state")).toBe("copied");
    // The textarea is removed again once the copy succeeded.
    expect(body.childNodes).toHaveLength(0);
  });

  it("selects the text for a manual copy when execCommand is unavailable", async () => {
    vi.useFakeTimers();
    const body = new FakeElement("body");
    installGlobal("document", {
      body,
      createElement: (tagName) => new FakeElement(tagName),
    });
    installGlobal("navigator", {});

    const { createCopyButton } = await import("../src/ui/clipboard.js");
    const button = createCopyButton("raw response", () => "payload");

    click(button);
    expect(button.textContent).toBe("Selected");
    const area = body.childNodes[0];
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.value).toBe("payload");
    expect(area.selected).toBe(true);
  });
});

describe("duration formatting", () => {
  it("keeps sub-second readings in milliseconds and promotes longer ones", async () => {
    installDocument();
    const { formatDuration } = await import("../src/ui/clipboard.js");

    expect(formatDuration(0)).toBe("0.0 ms");
    expect(formatDuration(12.345)).toBe("12.3 ms");
    expect(formatDuration(999.94)).toBe("999.9 ms");
    expect(formatDuration(1_000)).toBe("1.00 s");
    expect(formatDuration(2_500)).toBe("2.50 s");
  });
});
