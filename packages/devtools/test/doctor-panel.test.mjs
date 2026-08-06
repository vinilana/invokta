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

  set textContent(value) {
    this.value = String(value);
  }
}

class FakeElement extends FakeNode {
  #attributes = new Map();
  #listeners = new Map();
  childNodes = [];
  classList = new FakeClassList();
  disabled = false;

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

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  click() {
    if (this.disabled) return;
    for (const listener of this.#listeners.get("click") ?? []) {
      listener({ currentTarget: this, preventDefault() {} });
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
  it("keeps one live status connected while rendering a healthy report", async () => {
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
    const panel = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("doctor-panel"),
    );
    const loadingStatus = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "status",
    );
    const refresh = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("doctor-refresh"),
    );

    expect(loadingStatus.textContent).toBe("Running checks…");
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(refresh.tagName).toBe("BUTTON");
    expect(refresh.getAttribute("type")).toBe("button");
    expect(refresh.getAttribute("aria-label")).toBe("Run doctor checks again");
    expect(refresh.textContent).toBe("Run again");
    expect(refresh.disabled).toBe(true);
    await waitFor(() => expect(container.textContent).toContain("Healthy"));
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
    const notesHeading = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.tagName === "H3" &&
        node.textContent === "Notes",
    );
    const sections = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("doctor-sections"),
    );
    const findingsSection = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("diagnostic-section--finding"),
    );
    const notesSection = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("diagnostic-section--note"),
    );

    expect(status).toBe(loadingStatus);
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(panel.getAttribute("aria-busy")).toBe("false");
    expect(refresh.disabled).toBe(false);
    expect(summary.classList.contains("doctor-summary--healthy")).toBe(true);
    expect(summary.textContent).toContain("No blocking issues found.");
    expect(container.textContent).toContain("No blocking findings");
    expect(container.textContent).not.toContain("[ engine / diagnostics ]");
    expect(container.textContent).not.toContain("Advisory notes");
    expect(notesHeading).toBeDefined();
    expect(sections).toBeDefined();
    expect(findingsSection.getAttribute("aria-labelledby")).toBe(
      "doctor-findings-title",
    );
    expect(notesSection.getAttribute("aria-labelledby")).toBe(
      "doctor-notes-title",
    );
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
    const loadingStatus = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "status",
    );

    await waitFor(() =>
      expect(container.textContent).toContain("Issues found"),
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
    const diagnosticBody = walk(finding).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("diagnostic-item-body"),
    );
    const code = walk(finding).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("diagnostic-code"),
    );
    const message = walk(finding).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("diagnostic-message"),
    );

    expect(status).toBe(loadingStatus);
    expect(summary.classList.contains("doctor-summary--issues")).toBe(true);
    expect(summary.textContent).toContain(
      "Resolve findings before serving the engine.",
    );
    expect(findings.tagName).toBe("OL");
    expect(finding.textContent).toContain("DESCRIBE_FAILED");
    expect(finding.textContent).toContain("fixture.broken");
    expect(finding.textContent).toContain("Fixture describe failed.");
    expect(diagnosticBody).toBeDefined();
    expect(finding.getAttribute("aria-labelledby")).toBe(
      code.getAttribute("id"),
    );
    expect(finding.getAttribute("aria-describedby")).toBe(
      message.getAttribute("id"),
    );
    expect(details.textContent).toContain("Raw details");

    dispose();
  });

  it("can run the checks again without replacing the live status", async () => {
    installDocument();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          engineName: "fixture-engine",
          engineVersion: "1.2.3",
          capabilityCount: 2,
          findings: [],
          notes: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          engineName: "fixture-engine",
          engineVersion: "1.2.3",
          capabilityCount: 2,
          findings: [{ code: "TITLE_MISSING", capabilityId: "fixture.one" }],
          notes: [],
        }),
      );
    installGlobal("fetch", fetchMock);

    const { renderDoctorPanel } = await import("../src/ui/doctor-panel.js");
    const container = new FakeElement("main");
    const dispose = renderDoctorPanel(container);
    const panel = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.classList.contains("doctor-panel"),
    );
    const status = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "status",
    );
    const refresh = walk(container).find(
      (node) =>
        node instanceof FakeElement &&
        node.classList.contains("doctor-refresh"),
    );

    await waitFor(() => expect(status.textContent).toBe("Healthy"));
    refresh.click();

    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(refresh.disabled).toBe(true);
    expect(status.textContent).toBe("Running checks…");
    await waitFor(() => expect(status.textContent).toBe("Issues found"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(panel.getAttribute("aria-busy")).toBe("false");
    expect(refresh.disabled).toBe(false);
    expect(container.textContent).toContain("fixture.one");

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
    const loadingStatus = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "status",
    );

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Doctor checks could not be loaded.",
      ),
    );
    const alert = walk(container).find(
      (node) =>
        node instanceof FakeElement && node.getAttribute("role") === "alert",
    );

    expect(alert).toBe(loadingStatus);
    expect(alert.getAttribute("aria-atomic")).toBe("true");

    dispose();
  });
});
