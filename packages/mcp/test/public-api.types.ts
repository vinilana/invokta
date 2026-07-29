import type { Engine, Principal } from "@ai-engine/core";
import { expectTypeOf } from "vitest";

import {
  type McpHttpAuthenticationRequest,
  type McpHttpServerHandle,
  type ServeMcpHttpOptions,
  type ServeMcpStdioOptions,
  serveMcpHttp,
  serveMcpStdio,
} from "../src/index.js";

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
