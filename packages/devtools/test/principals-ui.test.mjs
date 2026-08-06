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

  focus() {
    this.focused = true;
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
  it("selects a principal without minting a token during initialization", async () => {
    installBrowser(async (_path, options = {}) => {
      if (options.method !== undefined) {
        throw new Error(`Unexpected credential mutation: ${options.method}`);
      }
      return jsonResponse([{ key: "p1", principal: { id: "local-dev" } }]);
    });

    const principals = await import("../src/ui/principals.js");
    await principals.ensureActiveToken();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(principals.getActivePrincipalKey()).toBe("p1");
    expect(principals.getActiveToken()).toBeNull();
    expect(principals.getActivePrincipalStatus()).toEqual({
      key: "p1",
      principalId: "local-dev",
      hasSessionToken: false,
    });
  });

  it("prunes stale tokens and prefers an available session token", async () => {
    installBrowser(async () =>
      jsonResponse([
        { key: "p1", principal: { id: "local-dev" } },
        { key: "p2", principal: { id: "reviewer" } },
      ]),
    );
    sessionStorage.setItem(
      "invokta-devtools.tokens",
      JSON.stringify({ old: "expired", p2: "secret" }),
    );
    sessionStorage.setItem("invokta-devtools.active", "old");

    const principals = await import("../src/ui/principals.js");
    await principals.ensureActiveToken();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(principals.getActivePrincipalKey()).toBe("p2");
    expect(principals.getActiveToken()).toBe("secret");
    expect(
      JSON.parse(sessionStorage.getItem("invokta-devtools.tokens")),
    ).toEqual({ p2: "secret" });
  });

  it("returns an unsubscribe function for principal change listeners", async () => {
    installBrowser(async () => jsonResponse([]));
    const principals = await import("../src/ui/principals.js");
    const listener = vi.fn();
    const unsubscribe = principals.onPrincipalChange(listener);

    principals.setActivePrincipal("p1");
    unsubscribe();
    principals.setActivePrincipal("p2");

    expect(listener).toHaveBeenCalledTimes(1);
  });

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

    await waitFor(() =>
      expect(container.textContent).toContain("Token in session"),
    );
    expect(container.textContent).toContain("Active");
    expect(container.textContent).toContain("Inactive");
    expect(container.textContent).toContain("No session token");
    expect(container.textContent).toContain("Act as");
    expect(container.textContent).toContain("Rotate token and use…");
    expect(container.textContent).toContain(
      "Rotating a token revokes the previous token immediately.",
    );
    const row = walk(container).find(
      (node) => node.getAttribute?.("role") === "group",
    );
    expect(row.getAttribute("aria-label")).toBe("Test identity local-dev");
    expect(container.textContent).toContain("Test identities");
    expect(container.textContent).toContain("Principal ID");
    expect(container.textContent).not.toContain("Development principals");
    const status = walk(row).find(
      (node) => node.getAttribute?.("aria-live") === "polite",
    );
    expect(status).toBeDefined();
  });

  it("requires an explicit confirmation before rotating an existing principal token", async () => {
    installBrowser(async (_path, options = {}) => {
      if (options.method === "POST") return new Promise(() => undefined);
      return jsonResponse([{ key: "p1", principal: { id: "local-dev" } }]);
    });
    sessionStorage.setItem(
      "invokta-devtools.tokens",
      JSON.stringify({ p1: "secret" }),
    );

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() =>
      expect(container.textContent).toContain("Rotate token and use…"),
    );

    const rotateButton = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" &&
        node.textContent === "Rotate token and use…",
    );
    rotateButton.dispatchEvent(new Event("click"));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rotateButton.textContent).toBe("Confirm rotation");
    expect(container.textContent).toContain(
      "The current token will stop working immediately.",
    );

    rotateButton.dispatchEvent(new Event("click"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/principals",
      expect.objectContaining({ method: "POST" }),
    );
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
    expect(deleteButton.getAttribute("aria-expanded")).toBeNull();
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

  it("associates creation errors with the invalid field and moves focus", async () => {
    installBrowser(async () => jsonResponse([]));

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() =>
      expect(container.textContent).toContain("Add identity"),
    );

    const elements = walk(container);
    const idInput = elements.find(
      (node) => node.getAttribute?.("id") === "new-principal-id",
    );
    const attributesInput = elements.find(
      (node) => node.getAttribute?.("id") === "new-principal-attributes",
    );
    const createButton = elements.find(
      (node) =>
        node.tagName === "BUTTON" && node.textContent === "Add identity",
    );

    createButton.dispatchEvent(new Event("click"));
    expect(idInput.getAttribute("aria-invalid")).toBe("true");
    expect(idInput.getAttribute("aria-errormessage")).toBe(
      "new-principal-feedback",
    );
    expect(idInput.focused).toBe(true);

    idInput.value = "reviewer";
    attributesInput.value = "[]";
    createButton.dispatchEvent(new Event("click"));
    expect(idInput.getAttribute("aria-invalid")).toBe("false");
    expect(attributesInput.getAttribute("aria-invalid")).toBe("true");
    expect(attributesInput.getAttribute("aria-errormessage")).toBe(
      "new-principal-feedback",
    );
    expect(attributesInput.focused).toBe(true);
  });

  it("keeps a live success status mounted and focuses a principal after activation", async () => {
    installBrowser(async () =>
      jsonResponse([
        { key: "p1", principal: { id: "local-dev" } },
        { key: "p2", principal: { id: "reviewer" } },
      ]),
    );
    sessionStorage.setItem("invokta-devtools.active", "p1");

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() => expect(container.textContent).toContain("Act as"));

    const panelStatus = walk(container).find(
      (node) => node.getAttribute?.("id") === "principals-panel-status",
    );
    expect(panelStatus.getAttribute("role")).toBe("status");
    const reviewerRow = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity reviewer",
    );
    const activate = walk(reviewerRow).find(
      (node) => node.tagName === "BUTTON" && node.textContent === "Act as",
    );
    activate.dispatchEvent(new Event("click"));

    await waitFor(() =>
      expect(panelStatus.textContent).toBe(
        "“reviewer” is now active. No session token is available.",
      ),
    );
    expect(walk(container)).toContain(panelStatus);
    const refreshedReviewerRow = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity reviewer",
    );
    expect(refreshedReviewerRow.getAttribute("tabindex")).toBe("-1");
    expect(refreshedReviewerRow.focused).toBe(true);
  });

  it("announces token success and restores focus to the refreshed token action", async () => {
    let issueCount = 0;
    installBrowser(async (_path, options = {}) => {
      if (options.method === "POST") {
        issueCount += 1;
        return jsonResponse({
          key: "p1",
          token: `secret-${String(issueCount)}`,
          principal: { id: "local-dev" },
        });
      }
      return jsonResponse([{ key: "p1", principal: { id: "local-dev" } }]);
    });
    sessionStorage.setItem("invokta-devtools.active", "p1");

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() =>
      expect(container.textContent).toContain("Rotate token and use…"),
    );
    const panelStatus = walk(container).find(
      (node) => node.getAttribute?.("id") === "principals-panel-status",
    );
    const rotateWithoutSessionToken = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" &&
        node.textContent === "Rotate token and use…",
    );
    rotateWithoutSessionToken.dispatchEvent(new Event("click"));
    expect(panelStatus.textContent).toBe("");
    expect(container.textContent).toContain(
      "The current token will stop working immediately.",
    );
    rotateWithoutSessionToken.dispatchEvent(new Event("click"));

    await waitFor(() =>
      expect(panelStatus.textContent).toBe(
        "Rotated the session token for “local-dev” and made it active. The previous token was revoked.",
      ),
    );
    let rotate = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" &&
        node.textContent === "Rotate token and use…",
    );
    expect(rotate.focused).toBe(true);

    rotate.dispatchEvent(new Event("click"));
    rotate.dispatchEvent(new Event("click"));
    await waitFor(() =>
      expect(panelStatus.textContent).toBe(
        "Rotated the session token for “local-dev” and made it active. The previous token was revoked.",
      ),
    );
    rotate = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" &&
        node.textContent === "Rotate token and use…",
    );
    expect(rotate.focused).toBe(true);
    expect(walk(container)).toContain(panelStatus);
  });

  it("restores focus after create and delete success", async () => {
    let records = [{ key: "p1", principal: { id: "local-dev" } }];
    installBrowser(async (_path, options = {}) => {
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        const issued = {
          key: "p2",
          token: "reviewer-secret",
          principal: body.principal,
        };
        records = [
          ...records,
          { key: issued.key, principal: issued.principal },
        ];
        return jsonResponse(issued, 201);
      }
      if (options.method === "DELETE") {
        const body = JSON.parse(options.body);
        records = records.filter(({ key }) => key !== body.key);
        return new Response(null, { status: 204 });
      }
      return jsonResponse(records);
    });
    sessionStorage.setItem("invokta-devtools.active", "p1");

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() =>
      expect(container.textContent).toContain("Add identity"),
    );
    const panelStatus = walk(container).find(
      (node) => node.getAttribute?.("id") === "principals-panel-status",
    );
    const idInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-id",
    );
    idInput.value = "reviewer";
    const create = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" && node.textContent === "Add identity",
    );
    create.dispatchEvent(new Event("click"));

    await waitFor(() =>
      expect(panelStatus.textContent).toBe(
        "Added “reviewer”, minted its session token, and made it active.",
      ),
    );
    const refreshedCreate = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" && node.textContent === "Add identity",
    );
    expect(refreshedCreate.parentNode.getAttribute("open")).toBe("");
    expect(refreshedCreate.focused).toBe(true);

    const reviewerRow = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity reviewer",
    );
    const deleteReviewer = walk(reviewerRow).find(
      (node) => node.tagName === "BUTTON" && node.textContent === "Delete…",
    );
    deleteReviewer.dispatchEvent(new Event("click"));
    deleteReviewer.dispatchEvent(new Event("click"));

    await waitFor(() =>
      expect(panelStatus.textContent).toBe(
        "Deleted “reviewer” and revoked its token.",
      ),
    );
    const localRow = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity local-dev",
    );
    expect(localRow.focused).toBe(true);

    const deleteLocal = walk(localRow).find(
      (node) => node.tagName === "BUTTON" && node.textContent === "Delete…",
    );
    deleteLocal.dispatchEvent(new Event("click"));
    deleteLocal.dispatchEvent(new Event("click"));
    await waitFor(() =>
      expect(panelStatus.textContent).toBe(
        "Deleted “local-dev” and revoked its token.",
      ),
    );
    const heading = walk(container).find(
      (node) => node.tagName === "H2" && node.textContent === "Test identities",
    );
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(heading.focused).toBe(true);
    expect(walk(container)).toContain(panelStatus);
  });
});
