import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { serveMcpHttp, type McpHttpServerHandle } from "@invokta/mcp";
import { exportJWK, generateKeyPair } from "jose";
import { Provider } from "oidc-provider";
import { afterEach, describe, expect, it } from "vitest";

import { createSelfHostedOAuthEngine } from "../../../examples/auth-self-hosted-oauth-engine/src/engine.js";
import {
  createJwtAccessTokenVerifier,
  createOAuthHttpAuth,
} from "../../../examples/auth-self-hosted-oauth-engine/src/http-auth.js";
import { createInteractionHandler } from "../../../examples/auth-self-hosted-oauth-engine/src/oauth/interaction-server.js";
import { createOAuthProviderConfiguration } from "../../../examples/auth-self-hosted-oauth-engine/src/oauth/oauth-provider.js";
import { createAttachedSessionController } from "../src/attached-session.js";

interface ProxyRecord {
  readonly method: string;
  readonly path: string;
  readonly authenticated: boolean;
}

interface BrowserResult {
  readonly response: Response;
  readonly url: URL;
  readonly body: string;
}

const nodeServers: NodeHttpServer[] = [];
const mcpServers: McpHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(
    mcpServers.splice(0).map((server) => server.close()),
  );
  await Promise.all(
    nodeServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: NodeHttpServer): Promise<number> {
  nodeServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function singleHeader(
  value: string | readonly string[] | undefined,
): string | undefined {
  return Array.isArray(value)
    ? value.join(", ")
    : (value as string | undefined);
}

function proxyHeaders(
  headers: IncomingHttpHeaders,
  publicHost: string,
): IncomingHttpHeaders {
  const forwarded = { ...headers };
  delete forwarded.connection;
  delete forwarded.host;
  return {
    ...forwarded,
    host: publicHost,
    "x-forwarded-host": publicHost,
    "x-forwarded-proto": "http",
  };
}

function forward(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  publicHost: string,
): void {
  const outgoing = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request.headers, publicHost),
    },
    (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    },
  );
  outgoing.once("error", () => {
    if (!response.headersSent) response.statusCode = 502;
    response.end();
  });
  request.pipe(outgoing);
}

function formValue(html: string, name: "action" | "csrf"): string {
  const pattern =
    name === "action"
      ? /<form method="post" action="([^"]+)"/u
      : /<input type="hidden" name="csrf" value="([^"]+)"/u;
  const value = pattern.exec(html)?.[1];
  if (value === undefined)
    throw new Error(`The ${name} form value is missing.`);
  return value;
}

class CookieBrowser {
  private readonly cookies = new Map<string, string>();

  async request(
    url: URL,
    options: {
      readonly method?: "GET" | "POST";
      readonly form?: URLSearchParams;
    } = {},
  ): Promise<Response> {
    const cookie = [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    const response = await fetch(url, {
      method: options.method ?? "GET",
      redirect: "manual",
      headers: {
        ...(cookie === "" ? {} : { cookie }),
        ...(options.form === undefined
          ? {}
          : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(options.form === undefined ? {} : { body: options.form.toString() }),
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair === undefined || separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  async followToPage(first: Response, callback: URL): Promise<BrowserResult> {
    let response = first;
    for (let redirects = 0; redirects < 12; redirects += 1) {
      const location = response.headers.get("location");
      if (
        response.status < 300 ||
        response.status >= 400 ||
        location === null
      ) {
        return {
          response,
          url: new URL(response.url),
          body: await response.text(),
        };
      }
      const next = new URL(location, response.url);
      if (
        next.origin === callback.origin &&
        next.pathname === callback.pathname
      ) {
        return { response, url: next, body: "" };
      }
      response = await this.request(next);
    }
    throw new Error("The OAuth browser redirect limit was exceeded.");
  }
}

describe("official self-hosted OAuth devtools homologation", () => {
  it("completes DCR, PKCE, login, one-click consent, token exchange, catalog, and an authenticated tool call", async () => {
    let authPort: number | undefined;
    let mcpPort: number | undefined;
    let publicHost = "";
    const records: ProxyRecord[] = [];
    const proxy = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://proxy.invalid").pathname;
      records.push({
        method: request.method ?? "",
        path,
        authenticated:
          singleHeader(request.headers.authorization)?.startsWith("Bearer ") ===
          true,
      });
      const protectedResource =
        path === "/mcp" || path === "/.well-known/oauth-protected-resource/mcp";
      const targetPort = protectedResource ? mcpPort : authPort;
      if (targetPort === undefined) {
        response.writeHead(503).end();
        return;
      }
      forward(request, response, targetPort, publicHost);
    });
    const publicPort = await listen(proxy);
    publicHost = `127.0.0.1:${String(publicPort)}`;
    const publicOrigin = `http://${publicHost}`;
    const resource = `${publicOrigin}/mcp`;

    const account = {
      id: "person:owner",
      email: "owner@example.test",
    } as const;
    const password = "correct horse battery staple";
    const users = {
      async findAccount(subject: string) {
        return subject === account.id ? account : null;
      },
      async authenticate(email: string, candidate: string) {
        return email === account.email && candidate === password
          ? account
          : null;
      },
    };
    const { privateKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const signingKey = await exportJWK(privateKey);
    Object.assign(signingKey, {
      alg: "ES256",
      kid: "devtools-integration-key",
      use: "sig",
    });
    const provider = new Provider(
      publicOrigin,
      createOAuthProviderConfiguration({
        secrets: {
          cookieKeys: ["integration-cookie-key-with-at-least-32-characters"],
          jwks: { keys: [signingKey] },
        },
        server: {
          issuer: publicOrigin,
          resource,
          host: "127.0.0.1",
          port: 1,
          allowedHosts: ["127.0.0.1"],
        },
        users,
      }),
    );
    provider.proxy = true;
    const interaction = createInteractionHandler({
      provider,
      users,
      csrfKey: "integration-cookie-key-with-at-least-32-characters",
    });
    const providerHandler = provider.callback();
    const authServer = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", publicOrigin).pathname;
        if (await interaction(request, response, path)) return;
        providerHandler(request, response);
      })().catch(() => {
        if (!response.headersSent) response.statusCode = 500;
        if (!response.writableEnded) response.end();
      });
    });
    authPort = await listen(authServer);

    const mcpServer = await serveMcpHttp(createSelfHostedOAuthEngine(), {
      port: 0,
      allowedHosts: [publicHost],
      auth: createOAuthHttpAuth({
        issuer: publicOrigin,
        resource,
        scopes: ["mcp:tools"],
        verifier: createJwtAccessTokenVerifier({
          issuer: publicOrigin,
          resource,
          jwksUrl: `${publicOrigin}/jwks`,
        }),
      }),
    });
    mcpServers.push(mcpServer);
    mcpPort = mcpServer.address().port;

    const controller = createAttachedSessionController();
    const owner = "devtools-integration-owner";
    const state = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";
    const callback = new URL("http://127.0.0.1:43123/oauth/callback");
    const started = await controller.beginOAuth(
      owner,
      {
        transport: "http",
        url: resource,
        authentication: { type: "oauth" },
      },
      { redirectUrl: callback.href, state },
    );

    const browser = new CookieBrowser();
    const login = await browser.followToPage(
      await browser.request(new URL(started.authorizationUrl)),
      callback,
    );
    expect(login.body).toContain("<h1>Sign in</h1>");
    const loginResponse = await browser.request(
      new URL(formValue(login.body, "action"), publicOrigin),
      {
        method: "POST",
        form: new URLSearchParams({
          csrf: formValue(login.body, "csrf"),
          email: account.email,
          password,
        }),
      },
    );
    const consent = await browser.followToPage(loginResponse, callback);
    expect(consent.body).toContain("<h1>Authorize");
    const consentAction = new URL(
      formValue(consent.body, "action"),
      publicOrigin,
    );
    const consentForm = new URLSearchParams({
      csrf: formValue(consent.body, "csrf"),
      decision: "approve",
    });
    const callbackResult = await browser.followToPage(
      await browser.request(consentAction, {
        method: "POST",
        form: consentForm,
      }),
      callback,
    );
    expect(callbackResult.url.origin).toBe(callback.origin);
    expect(callbackResult.url.pathname).toBe(callback.pathname);
    expect(callbackResult.url.searchParams.get("state")).toBe(state);
    const code = callbackResult.url.searchParams.get("code");
    expect(code).not.toBeNull();

    const summary = await controller.completeOAuth(state, code ?? "");
    expect(summary).toMatchObject({
      transport: "http",
      server: { name: "auth-self-hosted-oauth-engine" },
      validation: { status: "ok" },
      toolCount: 1,
    });
    expect(controller.tools(owner).map((tool) => tool.name)).toEqual([
      "identity.whoami",
    ]);
    const result = await controller.call(owner, "identity.whoami", {});
    expect(result.response.structuredContent).toMatchObject({
      principalId: account.id,
      scopes: expect.arrayContaining(["mcp:tools"]),
    });

    await expect(
      controller.completeOAuth(state, code ?? ""),
    ).rejects.toMatchObject({
      code: "NOT_CONNECTED",
    });
    const retained = JSON.stringify({
      state: controller.state(owner),
      activity: controller.activity(owner),
      summary,
      result,
    });
    expect(retained).not.toContain(state);
    expect(retained).not.toContain(code ?? "authorization-code");
    expect(retained).not.toContain(password);
    expect(records.filter((record) => record.path === "/reg")).toHaveLength(1);
    expect(records.filter((record) => record.path === "/token")).toHaveLength(
      1,
    );
    expect(
      records.filter((record) => record.path === "/mcp" && record.authenticated)
        .length,
    ).toBeGreaterThanOrEqual(3);

    await controller.disconnect(owner);
  }, 30_000);
});
