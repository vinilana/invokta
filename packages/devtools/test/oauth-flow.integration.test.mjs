import { randomBytes } from "node:crypto";

import { beginMcpOAuthAuthorization, inspectMcpOAuth } from "@invokta/mcp";
import { afterEach, describe, expect, it } from "vitest";

import { startOAuthEngine } from "./fixtures/oauth-engine.mjs";
import { startOAuthProvider } from "./fixtures/oauth-provider.mjs";

/**
 * The whole OAuth chain against a real authorization server, which nothing in
 * this repository could exercise before: discovery, an interactive
 * authorization completed through the loopback redirect, and a tool call whose
 * principal the engine's own hook derived from the issued token.
 *
 * Both fixtures listen on ephemeral loopback ports, so the provider starts
 * first and the engine advertises whatever origin it got. The suite is `.mjs`
 * because it imports those fixtures directly, as its sibling does.
 */

const flowTimeoutMs = 30_000;
/** The client requires exactly 43 base64url characters, as 32 bytes give. */
const state = () => randomBytes(32).toString("base64url");
const redirectUrl = "http://127.0.0.1:4100/oauth/callback";

const started = [];

async function startPair() {
  const provider = await startOAuthProvider();
  started.push(provider);
  const engine = await startOAuthEngine({
    authorizationServerUrl: provider.url,
    signingKey: provider.signingKey,
  });
  started.push(engine);
  return { engineUrl: engine.url, providerUrl: provider.url };
}

/**
 * Stands in for the developer's browser: follows the authorization URL and
 * reads the code the provider redirects back with, without ever leaving
 * loopback.
 */
async function authorizationCodeFrom(authorizationUrl) {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  const redirected = new URL(location);
  const code = redirected.searchParams.get("code");
  const returnedState = redirected.searchParams.get("state");
  expect(code).not.toBeNull();
  expect(returnedState).not.toBeNull();
  return { code, state: returnedState };
}

afterEach(async () => {
  for (const handle of started.splice(0).reverse()) {
    await handle.close().catch(() => undefined);
  }
});

describe("OAuth discovery", () => {
  it(
    "reports every leg of the chain against a correctly configured engine",
    async () => {
      const { engineUrl, providerUrl } = await startPair();

      const inspection = await inspectMcpOAuth({
        transport: "http",
        url: engineUrl,
        authentication: { type: "oauth" },
      });

      expect(inspection.steps.map((step) => step.name)).toEqual([
        "challenge",
        "resource-metadata",
        "authorization-server-metadata",
        "registration",
      ]);
      expect(inspection.steps.map((step) => step.outcome)).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
      ]);
      expect(inspection.ready).toBe(true);
      // The advertised server is on another origin than the resource, which is
      // the topology every real identity provider has.
      expect(new URL(providerUrl).origin).not.toBe(new URL(engineUrl).origin);
      expect(
        inspection.steps.some((step) => step.summary.includes(providerUrl)),
      ).toBe(true);
    },
    flowTimeoutMs,
  );

  it(
    "attributes a failure to the leg that produced it",
    async () => {
      const provider = await startOAuthProvider();
      started.push(provider);
      const engine = await startOAuthEngine({
        authorizationServerUrl: provider.url,
        signingKey: provider.signingKey,
      });
      started.push(engine);
      // The engine keeps advertising a provider that is no longer listening.
      await provider.close();

      const inspection = await inspectMcpOAuth({
        transport: "http",
        url: engine.url,
        authentication: { type: "oauth" },
      });

      const byName = new Map(inspection.steps.map((step) => [step.name, step]));
      expect(byName.get("challenge").outcome).toBe("ok");
      expect(byName.get("resource-metadata").outcome).toBe("ok");
      expect(byName.get("authorization-server-metadata").outcome).toBe(
        "failed",
      );
      expect(byName.get("authorization-server-metadata").hint).toBeDefined();
      // A leg that could not run says so instead of reporting a failure it
      // never attempted.
      expect(byName.get("registration").outcome).toBe("skipped");
      expect(inspection.ready).toBe(false);
    },
    flowTimeoutMs,
  );
});

describe("interactive authorization", () => {
  it(
    "completes the flow and invokes as the principal the engine derived",
    async () => {
      const { engineUrl } = await startPair();

      const authorization = await beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: engineUrl,
          authentication: { type: "oauth" },
        },
        { redirectUrl, state: state() },
      );
      const returned = await authorizationCodeFrom(
        authorization.authorizationUrl,
      );
      const connection = await authorization.finish(returned.code);

      try {
        const tools = await connection.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain(
          "fixture_whoami",
        );

        const called = await connection.callTool("fixture_whoami", {
          marker: "authorized",
        });
        expect(called.response.isError).not.toBe(true);
        expect(called.response.structuredContent.marker).toBe("authorized");
        expect(called.response.structuredContent.source).toBe("mcp-http");
        // The identity came from the engine's own authenticate hook verifying
        // the issued token, not from anything the devtools supplied.
        expect(called.response.structuredContent.principalId).toBe(
          "oauth:subject",
        );
      } finally {
        await connection.close();
      }
    },
    flowTimeoutMs,
  );

  it(
    "refuses an authorization code the provider never issued",
    async () => {
      const { engineUrl } = await startPair();

      const authorization = await beginMcpOAuthAuthorization(
        {
          transport: "http",
          url: engineUrl,
          authentication: { type: "oauth" },
        },
        { redirectUrl, state: state() },
      );
      await authorizationCodeFrom(authorization.authorizationUrl);

      await expect(authorization.finish("not-a-real-code")).rejects.toThrow();
      await authorization.close();
    },
    flowTimeoutMs,
  );
});
