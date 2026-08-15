import { afterEach, describe, expect, it, vi } from "vitest";

const originalDescriptors = new Map(
  ["document", "fetch", "sessionStorage", "EventSource"].map((name) => [
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

function dispatchTrace(source, entry) {
  const event = new Event("trace");
  Object.defineProperty(event, "data", { value: JSON.stringify(entry) });
  source.dispatchEvent(event);
}

/** Returns the event sources the panel opened, newest last. */
function installBrowser(fetchImplementation) {
  installGlobal("document", {
    createElement: (tagName) => new FakeElement(tagName),
  });
  installGlobal("sessionStorage", new MemoryStorage());
  installGlobal("fetch", vi.fn(fetchImplementation));
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
  installGlobal("EventSource", FakeEventSource);
  return sources;
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

  it("frames the token as the MCP HTTP credential it is", async () => {
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

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() =>
      expect(container.textContent).toContain("MCP HTTP credential"),
    );

    const withToken = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity local-dev",
    );
    const withoutToken = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity reviewer",
    );
    expect(withToken.textContent).toContain("Session token ready");
    expect(withoutToken.textContent).toContain("No session token");
    expect(withoutToken.textContent).toContain(
      "Only MCP HTTP against the devtools host presents one.",
    );
    // Nothing is broken without a token, so nothing warns about it.
    expect(container.textContent).not.toContain("Session token missing");
    const missing = walk(withoutToken).find(
      (node) => node.textContent === "No session token",
    );
    expect(missing.getAttribute("class")).toBe("badge");
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
      expect(container.textContent).toContain("Session token ready"),
    );
    expect(container.textContent).toContain("Selected");
    expect(container.textContent).toContain("Not selected");
    expect(container.textContent).toContain("No session token");
    expect(container.textContent).toContain("Act as");
    expect(container.textContent).toContain("Rotate token and use…");
    expect(container.textContent).toContain("Create session token and use…");
    expect(container.textContent).toContain(
      "Rotating a token revokes the previous token immediately.",
    );
    const row = walk(container).find(
      (node) => node.getAttribute?.("role") === "group",
    );
    expect(row.getAttribute("aria-label")).toBe("Test identity local-dev");
    expect(container.textContent).toContain("Test identities");
    // Identity is selected next to the adapter switch; this panel manages it.
    expect(container.textContent).toContain(
      "Manage the development identities the Playground can act as.",
    );
    expect(container.textContent).toContain("Principal ID");
    expect(container.textContent).not.toContain("Development principals");
    const status = walk(row).find(
      (node) => node.getAttribute?.("aria-live") === "polite",
    );
    expect(status).toBeDefined();
  });

  it("separates identity, invocation, credential, and creation controls", async () => {
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
      expect(container.textContent).toContain("2 test identities"),
    );
    const elements = walk(container);
    const header = elements.find((node) =>
      node.getAttribute?.("class")?.includes("principals-header"),
    );
    expect(header.textContent).toContain("Test identities");
    expect(header.textContent).toContain("2 test identities");

    const localRow = elements.find(
      (node) => node.getAttribute?.("aria-label") === "Test identity local-dev",
    );
    const localElements = walk(localRow);
    const identity = localElements.find((node) =>
      node.getAttribute?.("class")?.includes("principal-identity"),
    );
    const invocationState = localElements.find((node) =>
      node.getAttribute?.("class")?.includes("principal-invocation-state"),
    );
    const credentialState = localElements.find((node) =>
      node.getAttribute?.("class")?.includes("principal-credential-state"),
    );
    const actions = localElements.find((node) =>
      node.getAttribute?.("class")?.includes("principal-actions"),
    );
    expect(identity.textContent).toContain("local-dev");
    expect(identity.textContent).toContain("Internal key p1");
    expect(invocationState.textContent).toContain("Invocation");
    expect(invocationState.textContent).toContain("Selected");
    expect(credentialState.textContent).toContain("MCP HTTP credential");
    expect(credentialState.textContent).toContain("Session token ready");
    expect(localRow.getAttribute("aria-describedby")).toBe(
      "principal-invocation-state-0 principal-credential-state-0",
    );
    expect(actions.getAttribute("aria-label")).toBe("Actions for local-dev");

    const createSection = elements.find((node) =>
      node.getAttribute?.("class")?.includes("principal-create"),
    );
    const createBody = walk(createSection).find((node) =>
      node.getAttribute?.("class")?.includes("principal-create-body"),
    );
    expect(createSection.textContent).toContain("Add identity");
    expect(createSection.textContent).toContain(
      "Mints a token and activates it",
    );
    expect(createBody.textContent).toContain("Principal ID");
    expect(createBody.textContent).toContain("Attributes (JSON, optional)");
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
      expect(panelStatus.textContent).toBe("“reviewer” is now active."),
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
      expect(container.textContent).toContain("Create session token and use…"),
    );
    const panelStatus = walk(container).find(
      (node) => node.getAttribute?.("id") === "principals-panel-status",
    );
    const createSessionToken = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" &&
        node.textContent === "Create session token and use…",
    );
    createSessionToken.dispatchEvent(new Event("click"));
    expect(panelStatus.textContent).toBe("");
    expect(container.textContent).toContain(
      "Create a session token for “local-dev” and use it for invocations?",
    );
    createSessionToken.dispatchEvent(new Event("click"));

    await waitFor(() =>
      expect(panelStatus.textContent).toBe(
        "Created a session token for “local-dev” and selected it for invocations.",
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
    const refreshedCreateSection = walk(container).find((node) =>
      node.getAttribute?.("class")?.includes("principal-create"),
    );
    expect(refreshedCreateSection.getAttribute("open")).toBe("");
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

  it("fills the create form from attribute presets", async () => {
    installBrowser(async () => jsonResponse([]));

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() => expect(container.textContent).toContain("Quick fill:"));

    const idInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-id",
    );
    const attributesInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-attributes",
    );
    const presets = walk(container).filter(
      (node) => node.getAttribute?.("class") === "principal-preset",
    );
    expect(presets.map((button) => button.textContent)).toEqual([
      "Ticket analyst",
      "Ticket reader",
      "No permissions",
    ]);

    // The presets carry the attributes the repository's own access rules
    // read, so a filled form passes or fails a real rule.
    presets[0].dispatchEvent(new Event("click"));
    expect(idInput.value).toBe("local:operations-analyst");
    expect(JSON.parse(attributesInput.value)).toEqual({
      permissions: [
        "ticket:read",
        "ticket:classify",
        "ticket:draft-reply",
        "knowledge:search",
      ],
      allowedTicketIds: ["T-123", "T-456", "T-789"],
    });
    expect(idInput.focused).toBe(true);

    presets[2].dispatchEvent(new Event("click"));
    expect(idInput.value).toBe("local:no-permissions");
    expect(JSON.parse(attributesInput.value)).toEqual({ permissions: [] });
  });

  it("edits an identity in place through the create form", async () => {
    let records = [
      {
        key: "p1",
        principal: {
          id: "local-dev",
          attributes: { permissions: ["ticket:read"] },
        },
      },
    ];
    const requests = [];
    installBrowser(async (path, options = {}) => {
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        requests.push(body);
        records = [{ key: body.key, principal: body.principal }];
        return jsonResponse({ key: body.key, principal: body.principal });
      }
      if (options.method !== undefined) {
        throw new Error(`Unexpected request: ${options.method} ${path}`);
      }
      return jsonResponse(records);
    });
    sessionStorage.setItem("invokta-devtools.active", "p1");

    const principals = await import("../src/ui/principals.js");
    const repainted = vi.fn();
    principals.onPrincipalChange(repainted);
    const container = new FakeElement("main");
    principals.renderPrincipalsPanel(container);
    await waitFor(() => expect(container.textContent).toContain("Edit"));

    const row = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity local-dev",
    );
    const edit = walk(row).find(
      (node) => node.tagName === "BUTTON" && node.textContent === "Edit",
    );
    edit.dispatchEvent(new Event("click"));

    const createSection = walk(container).find((node) =>
      node.getAttribute?.("class")?.includes("principal-create"),
    );
    const idInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-id",
    );
    const attributesInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-attributes",
    );
    const submit = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" && node.textContent === "Save changes",
    );
    expect(createSection.getAttribute("open")).toBe("");
    expect(createSection.textContent).toContain("Edit identity");
    expect(createSection.textContent).toContain(
      "Editing “local-dev”. Its key and session token stay as they are.",
    );
    expect(idInput.value).toBe("local-dev");
    expect(JSON.parse(attributesInput.value)).toEqual({
      permissions: ["ticket:read"],
    });
    expect(idInput.focused).toBe(true);

    // The edit reuses the create form's validation rather than its own.
    attributesInput.value = "[]";
    submit.dispatchEvent(new Event("click"));
    expect(requests).toHaveLength(0);
    expect(attributesInput.getAttribute("aria-invalid")).toBe("true");
    expect(attributesInput.focused).toBe(true);

    attributesInput.value = '{"permissions":["ticket:classify"]}';
    idInput.value = "local:analyst";
    submit.dispatchEvent(new Event("click"));

    const panelStatus = walk(container).find(
      (node) => node.getAttribute?.("id") === "principals-panel-status",
    );
    await waitFor(() =>
      expect(panelStatus.textContent).toBe("Updated “local:analyst”."),
    );
    expect(requests).toEqual([
      {
        key: "p1",
        principal: {
          id: "local:analyst",
          attributes: { permissions: ["ticket:classify"] },
        },
      },
    ]);
    // The identity picker in the Playground shows the new name.
    expect(repainted).toHaveBeenCalled();
    expect(principals.listKnownPrincipals()).toEqual([
      {
        key: "p1",
        principal: {
          id: "local:analyst",
          attributes: { permissions: ["ticket:classify"] },
        },
      },
    ]);
    const updatedRow = walk(container).find(
      (node) =>
        node.getAttribute?.("aria-label") === "Test identity local:analyst",
    );
    expect(updatedRow.focused).toBe(true);
    // The form returns to creating once the edit lands.
    expect(
      walk(container).find(
        (node) =>
          node.tagName === "BUTTON" && node.textContent === "Add identity",
      ),
    ).toBeDefined();
  });

  it("leaves the edit form for a new identity when the edit is cancelled", async () => {
    installBrowser(async (_path, options = {}) => {
      if (options.method !== undefined) {
        throw new Error(`Unexpected request: ${options.method}`);
      }
      return jsonResponse([{ key: "p1", principal: { id: "local-dev" } }]);
    });

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() => expect(container.textContent).toContain("Edit"));

    const edit = walk(container).find(
      (node) => node.tagName === "BUTTON" && node.textContent === "Edit",
    );
    edit.dispatchEvent(new Event("click"));
    const cancel = walk(container).find(
      (node) =>
        node.getAttribute?.("aria-label") === "Cancel editing this identity",
    );
    expect(cancel.hidden).toBe(false);
    cancel.dispatchEvent(new Event("click"));

    const idInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-id",
    );
    expect(idInput.value).toBe("");
    expect(cancel.hidden).toBe(true);
    expect(
      walk(container).find(
        (node) =>
          node.tagName === "BUTTON" && node.textContent === "Add identity",
      ),
    ).toBeDefined();
  });

  it("summarises the recent emulated calls made as each identity", async () => {
    const sources = installBrowser(async () =>
      jsonResponse([
        { key: "p1", principal: { id: "local-dev" } },
        { key: "p2", principal: { id: "reviewer" } },
      ]),
    );

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    const dispose = renderPrincipalsPanel(container);
    await waitFor(() =>
      expect(container.textContent).toContain("No emulated calls yet."),
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("/api/events");

    dispatchTrace(sources[0], {
      kind: "adapter",
      id: 1,
      at: "2026-08-13T12:00:00.000Z",
      call: {
        adapter: "cli",
        capabilityId: "support.classify",
        outcome: "capability-error",
        durationMs: 4,
        errorCode: "ACCESS_DENIED",
        principalId: "local-dev",
        request: "{}",
        response: "{}",
      },
    });
    dispatchTrace(sources[0], {
      kind: "adapter",
      id: 2,
      at: "2026-08-13T12:00:01.000Z",
      call: {
        adapter: "direct",
        capabilityId: "support.summarize",
        outcome: "success",
        durationMs: 2,
        principalId: "local-dev",
        request: "{}",
        response: "{}",
      },
    });
    // An anonymous call belongs to no identity.
    dispatchTrace(sources[0], {
      kind: "adapter",
      id: 3,
      at: "2026-08-13T12:00:02.000Z",
      call: {
        adapter: "direct",
        capabilityId: "support.classify",
        outcome: "adapter-error",
        durationMs: 1,
        principalId: null,
        request: "{}",
        response: "{}",
      },
    });

    const localRow = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity local-dev",
    );
    const reviewerRow = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity reviewer",
    );
    const recent = walk(localRow).find((node) =>
      node.getAttribute?.("class")?.includes("principal-recent"),
    );
    expect(recent.textContent).toContain("Recent");
    // Newest first, so the summary reads like the Activity feed.
    expect(recent.textContent).toContain(
      "support.summarize · direct · Success",
    );
    expect(recent.textContent).toContain(
      "support.classify · cli · Capability error",
    );
    expect(reviewerRow.textContent).toContain("No emulated calls yet.");
    expect(container.textContent).not.toContain("support.classify · direct");

    dispose();
    expect(sources[0].closed).toBe(true);
  });

  it("duplicates an identity into the create form without copying tokens", async () => {
    installBrowser(async () =>
      jsonResponse([
        {
          key: "p1",
          principal: { id: "local-dev", attributes: { role: "admin" } },
        },
      ]),
    );

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() => expect(container.textContent).toContain("Duplicate"));

    const row = walk(container).find(
      (node) => node.getAttribute?.("aria-label") === "Test identity local-dev",
    );
    const duplicate = walk(row).find(
      (node) => node.tagName === "BUTTON" && node.textContent === "Duplicate",
    );
    duplicate.dispatchEvent(new Event("click"));

    const createSection = walk(container).find((node) =>
      node.getAttribute?.("class")?.includes("principal-create"),
    );
    const idInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-id",
    );
    const attributesInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-attributes",
    );
    expect(createSection.getAttribute("open")).toBe("");
    expect(idInput.value).toBe("local-dev-copy");
    expect(JSON.parse(attributesInput.value)).toEqual({ role: "admin" });
    expect(idInput.focused).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server error message when creation fails", async () => {
    installBrowser(async (_path, options = {}) => {
      if (options.method === "POST") {
        return jsonResponse({ error: "duplicate" }, 409);
      }
      return jsonResponse([]);
    });

    const { renderPrincipalsPanel } = await import("../src/ui/principals.js");
    const container = new FakeElement("main");
    renderPrincipalsPanel(container);
    await waitFor(() =>
      expect(container.textContent).toContain("Add identity"),
    );

    const idInput = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-id",
    );
    idInput.value = "local-dev";
    const create = walk(container).find(
      (node) =>
        node.tagName === "BUTTON" && node.textContent === "Add identity",
    );
    create.dispatchEvent(new Event("click"));

    const feedback = walk(container).find(
      (node) => node.getAttribute?.("id") === "new-principal-feedback",
    );
    await waitFor(() => expect(feedback.getAttribute("role")).toBe("alert"));
    expect(feedback.textContent).not.toBe("");
    // The api error message is surfaced, not the old fixed fallback.
    expect(feedback.textContent).not.toBe(
      "The test identity could not be added. Try again.",
    );
    expect(create.disabled).toBe(false);
    expect(create.textContent).toBe("Add identity");
  });
});
