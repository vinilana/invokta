import type { Engine, Principal } from "@invokta/core";
import { expectTypeOf } from "vitest";

import {
  beginMcpOAuthAuthorization,
  connectMcpClient,
  inspectMcpOAuth,
  type McpClientConnection,
  McpClientError,
  type McpClientOperationOptions,
  type McpClientServerInfo,
  type McpClientTarget,
  type McpClientTool,
  type McpClientToolPage,
  type McpClientToolResult,
  type McpHttpAuthenticationRequest,
  type McpHttpServerHandle,
  type McpJsonValue,
  type McpOAuthAuthorization,
  type McpOAuthAuthorizationOptions,
  type McpOAuthClientTarget,
  type McpOAuthInspection,
  type McpOAuthStep,
  type McpOAuthStepName,
  McpToolNameCollisionError,
  type ServeMcpHttpOptions,
  type ServeMcpStdioOptions,
  serveMcpHttp,
  serveMcpStdio,
  toMcpToolName,
  validateMcpToolCatalog,
} from "../src/index.js";

expectTypeOf(toMcpToolName("support.classify-ticket")).toEqualTypeOf<string>();

declare const catalogEngine: Engine;
expectTypeOf(validateMcpToolCatalog(catalogEngine)).toEqualTypeOf<void>();
const collision = new McpToolNameCollisionError(
  ["support.echo", "support_echo"],
  "support_echo",
);
expectTypeOf(collision.code).toEqualTypeOf<"MCP_TOOL_NAME_COLLISION">();
expectTypeOf(collision.capabilityIds).toEqualTypeOf<
  readonly [string, string]
>();
expectTypeOf(collision.toolName).toEqualTypeOf<string>();

const stdioTarget = {
  transport: "stdio",
  command: process.execPath,
  args: ["server.mjs"],
  env: { API_TOKEN: "secret" },
} as const satisfies McpClientTarget;
const httpTarget = {
  transport: "http",
  url: "https://mcp.example.com/mcp",
  authentication: { type: "bearer", token: "secret" },
} as const satisfies McpClientTarget;

expectTypeOf(connectMcpClient(stdioTarget)).toEqualTypeOf<
  Promise<McpClientConnection>
>();
expectTypeOf(
  connectMcpClient(httpTarget, { signal: new AbortController().signal }),
).toEqualTypeOf<Promise<McpClientConnection>>();

const oauthTarget = {
  transport: "http",
  url: "https://mcp.example.com/mcp",
  authentication: { type: "oauth" },
} as const satisfies McpOAuthClientTarget;
const oauthOptions: McpOAuthAuthorizationOptions = {
  redirectUrl: "http://127.0.0.1:4100/oauth/callback",
  state: "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF",
};
expectTypeOf(
  beginMcpOAuthAuthorization(oauthTarget, oauthOptions),
).toEqualTypeOf<Promise<McpOAuthAuthorization>>();

declare const oauthAuthorization: McpOAuthAuthorization;
expectTypeOf(oauthAuthorization.authorizationUrl).toEqualTypeOf<string>();
expectTypeOf(oauthAuthorization.finish("authorization-code")).toEqualTypeOf<
  Promise<McpClientConnection>
>();
expectTypeOf(oauthAuthorization.close()).toEqualTypeOf<Promise<void>>();

expectTypeOf(inspectMcpOAuth(oauthTarget)).toEqualTypeOf<
  Promise<McpOAuthInspection>
>();
expectTypeOf(
  inspectMcpOAuth(oauthTarget, { signal: new AbortController().signal }),
).toEqualTypeOf<Promise<McpOAuthInspection>>();

expectTypeOf<McpOAuthStepName>().toEqualTypeOf<
  | "challenge"
  | "resource-metadata"
  | "authorization-server-metadata"
  | "registration"
>();

declare const oauthInspection: McpOAuthInspection;
declare const oauthStep: McpOAuthStep;
expectTypeOf(oauthInspection.steps).toEqualTypeOf<readonly McpOAuthStep[]>();
expectTypeOf(oauthInspection.ready).toEqualTypeOf<boolean>();
expectTypeOf(oauthStep.name).toEqualTypeOf<McpOAuthStepName>();
expectTypeOf(oauthStep.outcome).toEqualTypeOf<"ok" | "failed" | "skipped">();
expectTypeOf(oauthStep.summary).toEqualTypeOf<string>();
expectTypeOf(oauthStep.hint).toEqualTypeOf<string | undefined>();
expectTypeOf(oauthStep.detail).toEqualTypeOf<McpJsonValue | undefined>();

// @ts-expect-error The inspection report is a read-only snapshot.
oauthInspection.steps[0] = oauthStep;

declare const connection: McpClientConnection;
expectTypeOf(connection.server).toEqualTypeOf<McpClientServerInfo>();
expectTypeOf(connection.listTools()).toEqualTypeOf<
  Promise<McpClientToolPage>
>();
expectTypeOf(connection.listTools("cursor", {})).toEqualTypeOf<
  Promise<McpClientToolPage>
>();
expectTypeOf(
  connection.callTool("example.inspect", { value: "ok" }),
).toEqualTypeOf<Promise<McpClientToolResult>>();
expectTypeOf(connection.close()).toEqualTypeOf<Promise<void>>();

declare const tool: McpClientTool;
expectTypeOf(tool.inputSchema).toEqualTypeOf<
  Readonly<Record<string, McpJsonValue>>
>();
expectTypeOf<McpClientOperationOptions["signal"]>().toEqualTypeOf<
  AbortSignal | undefined
>();

const clientError = new McpClientError(
  "INVALID_TARGET",
  "The MCP client target is invalid.",
);
expectTypeOf(clientError.code).toEqualTypeOf<
  | "INVALID_TARGET"
  | "SPAWN_FAILED"
  | "CONNECTION_FAILED"
  | "AUTHENTICATION_FAILED"
  | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "LIMIT_EXCEEDED"
  | "CANCELLED"
>();

declare const engine: Engine;
declare const principal: Principal;
declare const authenticationRequest: McpHttpAuthenticationRequest;
declare const httpServer: McpHttpServerHandle;

// @ts-expect-error Authentication headers are a read-only minimal view.
authenticationRequest.headers.set("authorization", "Bearer replacement");

// @ts-expect-error The neutral address does not imply a canonical public URL.
httpServer.address().url;

expectTypeOf(serveMcpStdio(engine, { principal })).toEqualTypeOf<
  Promise<void>
>();
expectTypeOf(serveMcpStdio(engine)).toEqualTypeOf<Promise<void>>();

const options: ServeMcpStdioOptions = {
  principal,
  maxReadBufferBytes: 10 * 1024 * 1024,
};
expectTypeOf(options).toEqualTypeOf<ServeMcpStdioOptions>();

serveMcpStdio(engine, {
  // @ts-expect-error The stdio read-buffer limit is measured in bytes.
  maxReadBufferBytes: "10485760",
});

serveMcpStdio(engine, {
  principal,
  // @ts-expect-error The public adapter does not accept MCP SDK transport objects.
  transport: {},
});

const httpOptions: ServeMcpHttpOptions = {
  maxRequestBodyBytes: 1024,
  auth: {
    mode: "required",
    challengeScopes: ["engine:invoke"],
    resourceMetadata: {
      resource: "https://engine.example.com/mcp",
      authorizationServers: ["https://identity.example.com"],
    },
    authenticate(request) {
      expectTypeOf(request.headers.get).toEqualTypeOf<
        (name: string) => string | null
      >();
      expectTypeOf(request.headers.has).toEqualTypeOf<
        (name: string) => boolean
      >();
      expectTypeOf(request.path).toEqualTypeOf<string>();
      expectTypeOf(request.signal).toEqualTypeOf<AbortSignal>();
      return principal;
    },
  },
};
expectTypeOf(serveMcpHttp(engine, httpOptions)).toEqualTypeOf<
  Promise<McpHttpServerHandle>
>();

serveMcpHttp(engine, {
  // @ts-expect-error Authentication cannot be omitted implicitly.
  auth: undefined,
});

serveMcpHttp(engine, {
  // @ts-expect-error The dangerous development opt-out is intentionally explicit.
  auth: { mode: "disabled" },
});

serveMcpHttp(engine, {
  auth: {
    mode: "required",
    authenticate: () => principal,
    // @ts-expect-error Metadata requires at least one authorization server.
    resourceMetadata: { resource: "https://engine.example.com/mcp" },
  },
});
