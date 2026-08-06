import { afterEach, describe, expect, it, vi } from "vitest";

const originalDescriptors = new Map(
  ["document", "fetch"].map((name) => [
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

class FakeClassList {
  #values = new Set();

  contains(name) {
    return this.#values.has(name);
  }

  replaceFrom(value) {
    this.#values = new Set(value.split(/\s+/).filter(Boolean));
  }
}

class FakeNode {
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
}

class FakeElement extends FakeNode {
  #attributes = new Map();
  childNodes = [];
  classList = new FakeClassList();

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

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
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

function installDocument() {
  installGlobal("document", {
    createElement: (tagName) => new FakeElement(tagName),
  });
}

afterEach(() => {
  vi.resetModules();
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe("doctor panel", () => {
  it("announces a healthy engine and keeps advisory notes scannable", async () => {
    installDocument();
    installGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          engineName: "fixture-engine",
          engineVersion: "1.2.3",
          capabilityCount: 2,
          findings: [],
          notes: [{ code: "MCP_MANIFEST_PRESENT" }],
        }),
      ),
    );

    const { renderDoctorPanel } = await import("../src/ui/doctor-panel.js");
    const container = new FakeElement("main");
    const dispose = renderDoctorPanel(container);

    await waitFor(() =>
      expect(container.textContent).toContain("Checks passed"),
    );
    const status = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "status",
    );
    const summary = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("doctor-summary"),
    );
    const note = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("diagnostic-item--note"),
    );

    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(summary.classList.contains("doctor-summary--healthy")).toBe(true);
    expect(container.textContent).toContain("No blocking findings");
    expect(note.textContent).toContain("MCP_MANIFEST_PRESENT");
    expect(note.textContent).toContain("invokta.mcp.json is present");

    dispose();
  });

  it("announces findings and renders issue context before raw details", async () => {
    installDocument();
    installGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          engineName: "fixture-engine",
          engineVersion: "1.2.3",
          capabilityCount: 1,
          findings: [
            {
              code: "DESCRIBE_FAILED",
              capabilityId: "fixture.broken",
              error: { name: "Error", message: "Fixture describe failed." },
            },
          ],
          notes: [],
        }),
      ),
    );

    const { renderDoctorPanel } = await import("../src/ui/doctor-panel.js");
    const container = new FakeElement("main");
    const dispose = renderDoctorPanel(container);

    await waitFor(() =>
      expect(container.textContent).toContain("1 finding needs attention"),
    );
    const summary = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("doctor-summary"),
    );
    const findings = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.getAttribute("aria-label") === "Doctor findings",
    );
    const finding = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("diagnostic-item--finding"),
    );
    const details = walk(finding).find(
      (node) => node instanceof FakeElement && node.tagName === "DETAILS",
    );

    expect(summary.classList.contains("doctor-summary--issues")).toBe(true);
    expect(findings.tagName).toBe("OL");
    expect(finding.textContent).toContain("DESCRIBE_FAILED");
    expect(finding.textContent).toContain("fixture.broken");
    expect(finding.textContent).toContain("Fixture describe failed.");
    expect(details.textContent).toContain("Raw details");

    dispose();
  });

  it("presents load failures as an alert", async () => {
    installDocument();
    installGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "internal_error" }, 500)),
    );

    const { renderDoctorPanel } = await import("../src/ui/doctor-panel.js");
    const container = new FakeElement("main");
    const dispose = renderDoctorPanel(container);

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Doctor checks could not be loaded.",
      ),
    );
    const alert = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "alert",
    );

    expect(alert.getAttribute("aria-atomic")).toBe("true");

    dispose();
  });
});
