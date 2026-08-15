import { afterEach, describe, expect, it } from "vitest";

import {
  createHttpTargetStore,
  HttpTargetError,
  parseHttpTarget,
} from "../src/http-target.js";

const environmentName = "INVOKTA_DEVTOOLS_TEST_CREDENTIAL";

afterEach(() => {
  delete process.env[environmentName];
});

describe("parseHttpTarget", () => {
  it("accepts the devtools host with its own two authentication types", () => {
    expect(
      parseHttpTarget({
        kind: "devtools",
        authentication: { type: "session-token" },
      }),
    ).toEqual({ kind: "devtools", authentication: { type: "session-token" } });
    expect(
      parseHttpTarget({ kind: "devtools", authentication: { type: "none" } }),
    ).toEqual({ kind: "devtools", authentication: { type: "none" } });
  });

  it("refuses an authentication the devtools host cannot perform", () => {
    // The host runs the devtools-owned hook, so a custom header would never
    // authenticate; offering it would describe a check that never happens.
    expect(() =>
      parseHttpTarget({
        kind: "devtools",
        authentication: {
          type: "headers",
          headers: [
            { name: "X-API-Key", value: { kind: "literal", value: "k" } },
          ],
        },
      }),
    ).toThrow(HttpTargetError);
  });

  it("accepts every authentication type for an external endpoint", () => {
    const url = "https://mcp.example.com/mcp";
    expect(
      parseHttpTarget({
        kind: "external",
        url,
        authentication: { type: "none" },
      }),
    ).toMatchObject({ kind: "external", url });
    expect(
      parseHttpTarget({
        kind: "external",
        url,
        authentication: {
          type: "bearer",
          token: { kind: "environment", name: environmentName },
        },
      }),
    ).toMatchObject({
      authentication: {
        type: "bearer",
        token: { kind: "environment", name: environmentName },
      },
    });
    expect(
      parseHttpTarget({
        kind: "external",
        url,
        authentication: {
          type: "headers",
          headers: [
            { name: "X-API-Key", value: { kind: "literal", value: "k" } },
          ],
        },
      }),
    ).toMatchObject({ authentication: { type: "headers" } });
    expect(
      parseHttpTarget({
        kind: "external",
        url,
        authentication: { type: "oauth" },
      }),
    ).toMatchObject({ authentication: { type: "oauth" } });
  });

  it("names what is wrong with an unusable descriptor", () => {
    const url = "https://mcp.example.com/mcp";
    expect(() => parseHttpTarget({ kind: "smtp" })).toThrow(
      /target kind is unknown/,
    );
    expect(() =>
      parseHttpTarget({ kind: "external", authentication: { type: "none" } }),
    ).toThrow(/absolute MCP URL/);
    expect(() =>
      parseHttpTarget({
        kind: "external",
        url,
        authentication: { type: "headers", headers: [] },
      }),
    ).toThrow(/at least one header/);
    expect(() =>
      parseHttpTarget({
        kind: "external",
        url,
        authentication: {
          type: "headers",
          headers: [{ name: "Host", value: { kind: "literal", value: "x" } }],
        },
      }),
    ).toThrow(/Host header/);
    // The whole facade policy applies, not just Host: a header the MCP client
    // refuses must be refused when the target is saved, not per invocation.
    for (const name of ["Cookie", "Origin", "Sec-Fetch-Mode", "Proxy-Auth"]) {
      expect(() =>
        parseHttpTarget({
          kind: "external",
          url,
          authentication: {
            type: "headers",
            headers: [{ name, value: { kind: "literal", value: "x" } }],
          },
        }),
      ).toThrow(/reserved by the MCP client/);
    }
    expect(() =>
      parseHttpTarget({
        kind: "external",
        url,
        authentication: {
          type: "bearer",
          token: { kind: "environment", name: "not a name" },
        },
      }),
    ).toThrow(/environment variable name is invalid/);
  });
});

describe("createHttpTargetStore", () => {
  it("starts on the devtools host with its session token", () => {
    const store = createHttpTargetStore();
    expect(store.view()).toEqual({
      kind: "devtools",
      authentication: { type: "session-token" },
    });
    expect(store.resolve()).toEqual({
      kind: "devtools",
      useSessionToken: true,
    });
  });

  it("never echoes a credential back to the interface", () => {
    const store = createHttpTargetStore();
    store.set({
      kind: "external",
      url: "https://mcp.example.com/mcp",
      authentication: {
        type: "headers",
        headers: [
          {
            name: "X-API-Key",
            value: { kind: "literal", value: "super-secret-value" },
          },
          {
            name: "X-Tenant",
            value: { kind: "environment", name: environmentName },
          },
        ],
      },
    });

    const view = JSON.stringify(store.view());
    expect(view).not.toContain("super-secret-value");
    expect(store.view()).toEqual({
      kind: "external",
      url: "https://mcp.example.com/mcp",
      authentication: {
        type: "headers",
        headerNames: ["X-API-Key", "X-Tenant"],
        environmentVariables: [environmentName],
      },
    });
  });

  it("resolves literal and environment credentials into one header set", () => {
    process.env[environmentName] = "from-environment";
    const store = createHttpTargetStore();
    store.set({
      kind: "external",
      url: "https://mcp.example.com/mcp",
      authentication: {
        type: "headers",
        headers: [
          { name: "X-API-Key", value: { kind: "literal", value: "literal" } },
          {
            name: "X-Tenant",
            value: { kind: "environment", name: environmentName },
          },
        ],
      },
    });

    expect(store.resolve()).toEqual({
      kind: "external",
      url: "https://mcp.example.com/mcp",
      authentication: {
        type: "headers",
        headers: { "X-API-Key": "literal", "X-Tenant": "from-environment" },
      },
    });
  });

  it("refuses to call anonymously when a named variable is unset", () => {
    const store = createHttpTargetStore();
    store.set({
      kind: "external",
      url: "https://mcp.example.com/mcp",
      authentication: {
        type: "bearer",
        token: { kind: "environment", name: environmentName },
      },
    });

    // Falling back to no credential would misreport what the endpoint accepts.
    expect(() => store.resolve()).toThrow(HttpTargetError);
    expect(() => store.resolve()).toThrow(new RegExp(environmentName));
  });

  it("reports an OAuth target as unauthorized until the flow completes", () => {
    const store = createHttpTargetStore();
    store.set({
      kind: "external",
      url: "https://mcp.example.com/mcp",
      authentication: { type: "oauth" },
    });
    expect(store.view().authentication.authorized).toBe(false);
    expect(store.resolve()).toEqual({
      kind: "external-oauth",
      url: "https://mcp.example.com/mcp",
    });

    store.markAuthorized(true);
    expect(store.view().authentication.authorized).toBe(true);

    // Selecting another target drops the authorization with the credential.
    store.reset();
    expect(store.view()).toEqual({
      kind: "devtools",
      authentication: { type: "session-token" },
    });
  });

  it("notifies subscribers and isolates their failures", () => {
    const store = createHttpTargetStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => {
      throw new Error("listener failure");
    });
    store.subscribe(() => {
      seen.push(store.view().kind);
    });

    store.set({
      kind: "external",
      url: "https://mcp.example.com/mcp",
      authentication: { type: "none" },
    });
    store.reset();
    unsubscribe();

    expect(seen).toEqual(["external", "devtools"]);
  });
});
