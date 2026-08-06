import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  attachedPrimaryTabs,
  buildHttpTarget,
  buildStdioTarget,
  completeConnectionAttempt,
  createRouteAttachedApi,
  filterAttachedTools,
  nextRovingIndex,
  parseToolArguments,
  type SecretControl,
} from "../src/ui/attached-app.js";

const uiDirectory = fileURLToPath(new URL("../src/ui/", import.meta.url));

describe("attached workbench target drafts", () => {
  it("keeps a stdio launch structured without a shell command string", () => {
    expect(
      buildStdioTarget({
        command: "node",
        args: ["server.js", "--tenant", "alpha beta", ""],
        cwd: "/workspace/server",
        environment: [
          { name: "API_TOKEN", value: "canary-token" },
          { name: "REGION", value: "south" },
        ],
      }),
    ).toEqual({
      transport: "stdio",
      command: "node",
      args: ["server.js", "--tenant", "alpha beta", ""],
      cwd: "/workspace/server",
      env: { API_TOKEN: "canary-token", REGION: "south" },
    });
  });

  it("builds none, bearer, and custom-header HTTP authentication", () => {
    expect(
      buildHttpTarget({
        url: "https://mcp.example.test/mcp",
        authentication: { type: "none" },
      }),
    ).toEqual({
      transport: "http",
      url: "https://mcp.example.test/mcp",
      authentication: { type: "none" },
    });

    expect(
      buildHttpTarget({
        url: "http://127.0.0.1:3000/mcp",
        authentication: { type: "bearer", token: "canary-bearer" },
      }),
    ).toEqual({
      transport: "http",
      url: "http://127.0.0.1:3000/mcp",
      authentication: { type: "bearer", token: "canary-bearer" },
    });

    expect(
      buildHttpTarget({
        url: "https://mcp.example.test/mcp",
        authentication: {
          type: "headers",
          headers: [
            { name: "X-API-Key", value: "canary-key" },
            { name: "X-Tenant", value: "alpha" },
          ],
        },
      }),
    ).toEqual({
      transport: "http",
      url: "https://mcp.example.test/mcp",
      authentication: {
        type: "headers",
        headers: { "X-API-Key": "canary-key", "X-Tenant": "alpha" },
      },
    });
  });

  it("rejects duplicate environment and header names before connecting", () => {
    expect(() =>
      buildStdioTarget({
        command: "node",
        args: [],
        environment: [
          { name: "TOKEN", value: "one" },
          { name: "TOKEN", value: "two" },
        ],
      }),
    ).toThrow("Environment names must be unique.");

    expect(() =>
      buildHttpTarget({
        url: "https://mcp.example.test/mcp",
        authentication: {
          type: "headers",
          headers: [
            { name: "X-Token", value: "one" },
            { name: "x-token", value: "two" },
          ],
        },
      }),
    ).toThrow("Header names must be unique.");

    expect(() =>
      buildHttpTarget({
        url: "https://mcp.example.test/mcp",
        authentication: {
          type: "headers",
          headers: [{ name: "Mcp-Protocol-Version", value: "owned" }],
        },
      }),
    ).toThrow("Transport-owned headers cannot be configured here.");
  });

  it("preserves prototype-like names as own target data", () => {
    const stdio = buildStdioTarget({
      command: "node",
      args: [],
      environment: [{ name: "__proto__", value: "stdio-secret" }],
    });
    expect(stdio.transport).toBe("stdio");
    if (stdio.transport !== "stdio") throw new Error("expected stdio target");
    expect(Object.getPrototypeOf(stdio.env)).toBeNull();
    expect(Object.hasOwn(stdio.env ?? {}, "__proto__")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(stdio.env ?? {}, "__proto__")?.value,
    ).toBe("stdio-secret");

    const http = buildHttpTarget({
      url: "https://mcp.example.test/mcp",
      authentication: {
        type: "headers",
        headers: [{ name: "__proto__", value: "header-secret" }],
      },
    });
    expect(http.transport).toBe("http");
    if (http.transport !== "http") throw new Error("expected HTTP target");
    if (http.authentication.type !== "headers") {
      throw new Error("expected custom headers");
    }
    expect(Object.getPrototypeOf(http.authentication.headers)).toBeNull();
    expect(Object.hasOwn(http.authentication.headers, "__proto__")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(http.authentication.headers, "__proto__")
        ?.value,
    ).toBe("header-secret");
  });

  it("clears every secret control after success and failure", async () => {
    const successful: SecretControl[] = [
      { value: "stdio-secret", placeholder: "" },
      { value: "bearer-secret", placeholder: "" },
    ];
    await expect(
      completeConnectionAttempt(Promise.resolve("connected"), successful),
    ).resolves.toBe("connected");
    expect(successful).toEqual([
      { value: "", placeholder: "Cleared after response" },
      { value: "", placeholder: "Cleared after response" },
    ]);

    const failed: SecretControl[] = [
      { value: "header-secret", placeholder: "" },
    ];
    await expect(
      completeConnectionAttempt(Promise.reject(new Error("refused")), failed),
    ).rejects.toThrow("refused");
    expect(failed).toEqual([
      { value: "", placeholder: "Cleared after response" },
    ]);
  });
});

describe("attached tools", () => {
  const tools = [
    {
      name: "tickets.classify",
      title: "Classify ticket",
      description: "Routes an incoming support request.",
      inputSchema: { type: "object" },
    },
    {
      name: "orders.lookup",
      description: "Finds an order.",
      inputSchema: { type: "object" },
    },
  ] as const;

  it("searches names, titles, and descriptions case-insensitively", () => {
    expect(filterAttachedTools(tools, "TICKET")).toEqual([tools[0]]);
    expect(filterAttachedTools(tools, "support request")).toEqual([tools[0]]);
    expect(filterAttachedTools(tools, "orders")).toEqual([tools[1]]);
    expect(filterAttachedTools(tools, "absent")).toEqual([]);
  });

  it("accepts only a JSON object for a manual call", () => {
    expect(parseToolArguments('{"ticketId":"T-123"}')).toEqual({
      ticketId: "T-123",
    });
    expect(() => parseToolArguments("[]")).toThrow(
      "Tool arguments must be a JSON object.",
    );
    expect(() => parseToolArguments("not json")).toThrow(
      "Tool arguments must be valid JSON.",
    );
  });

  it("computes wrapped roving focus for horizontal and vertical composites", () => {
    expect(nextRovingIndex(0, 3, "ArrowRight", "horizontal")).toBe(1);
    expect(nextRovingIndex(2, 3, "ArrowRight", "horizontal")).toBe(0);
    expect(nextRovingIndex(0, 3, "ArrowLeft", "horizontal")).toBe(2);
    expect(nextRovingIndex(1, 3, "Home", "vertical")).toBe(0);
    expect(nextRovingIndex(1, 3, "End", "vertical")).toBe(2);
    expect(nextRovingIndex(1, 3, "ArrowDown", "vertical")).toBe(2);
    expect(nextRovingIndex(1, 3, "ArrowRight", "vertical")).toBeUndefined();
    expect(nextRovingIndex(0, 0, "ArrowRight", "horizontal")).toBeUndefined();
  });
});

describe("attached workbench route adapter", () => {
  it("uses only documented routes and rotates in-memory CSRF tokens", async () => {
    const calls: Array<{
      readonly url: string;
      readonly init: RequestInit | undefined;
    }> = [];
    const responses = [
      new Response(
        JSON.stringify({
          csrfToken: "csrf-one",
          state: "idle",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        JSON.stringify({
          state: "connected",
          connection: {
            transport: "stdio",
            server: {
              name: "fixture-server",
              version: "1.2.3",
              protocolVersion: "2025-11-25",
            },
            pageCount: 1,
            toolCount: 1,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "X-Invokta-CSRF": "csrf-two",
          },
        },
      ),
      new Response(
        JSON.stringify({
          tools: [
            {
              name: "fixture.echo",
              description: "Echoes input.",
              inputSchema: { type: "object" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(JSON.stringify({ response: { content: [], ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ state: "idle" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "X-Invokta-CSRF": "csrf-three",
        },
      }),
    ];
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
    );
    const routeApi = createRouteAttachedApi(fetcher);
    const target = buildStdioTarget({
      command: "node",
      args: ["server.js"],
      environment: [],
    });

    await routeApi.session();
    await routeApi.connect(target);
    await routeApi.tools();
    await routeApi.callTool("fixture.echo", { message: "hello" });
    await routeApi.activity();
    await routeApi.disconnect();

    expect(calls.map(({ url }) => url)).toEqual([
      "/api/session",
      "/api/connection",
      "/api/tools",
      "/api/tools/call",
      "/api/activity",
      "/api/connection",
    ]);
    expect(calls[1]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "X-Invokta-CSRF": "csrf-one",
      },
    });
    expect(calls[3]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "X-Invokta-CSRF": "csrf-two",
      },
      body: JSON.stringify({
        name: "fixture.echo",
        arguments: { message: "hello" },
      }),
    });
    expect(calls[5]?.init).toMatchObject({
      method: "DELETE",
      headers: { "X-Invokta-CSRF": "csrf-two" },
    });
  });
});

describe("attached workbench interface contract", () => {
  it("exposes exactly the attached primary tabs", () => {
    expect(attachedPrimaryTabs).toEqual(["Tools", "Activity", "Connection"]);
  });

  it("keeps target data out of browser storage and ships responsive focus styles", () => {
    const app = readFileSync(`${uiDirectory}/attached-app.ts`, "utf8");
    const styles = readFileSync(`${uiDirectory}/attached-styles.ts`, "utf8");

    expect(app).not.toMatch(/localStorage|sessionStorage/);
    expect(app).not.toContain('el("style"');
    expect(app).not.toMatch(/\bstyle\s*:|style=/);
    expect(app).toContain('href: "/assets/attached.css"');
    expect(app).toContain('type: "password"');
    expect(app).toContain('role: "listbox"');
    expect(app).toContain('role: "option"');
    expect(app).toContain('"aria-errormessage"');
    expect(app).toContain('el("span", {}, ["JSON Schema"])');
    expect(styles).toContain(":focus-visible");
    expect(styles).toMatch(/@media \(max-width:/);
    expect(styles).toContain("@media (max-width: 22rem)");
    expect(styles).toContain(".att-theme-slot-compact { display: flex; }");
    expect(styles).not.toMatch(/font-size: 0\.(?:6\d|7[0-4])rem/);
    expect(styles).toContain("prefers-reduced-motion");
  });
});
