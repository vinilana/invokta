import type { Engine, EngineErrorCode, Principal } from "@invokta/core";
import { expectTypeOf } from "vitest";

import {
  createHttpHandler,
  createHttpOpenApiDocument,
  type HttpAdapterErrorCode,
  type HttpAuthenticationRequest,
  type HttpAuthOptions,
  type HttpCorsOptions,
  type HttpErrorBody,
  type HttpErrorCode,
  type HttpHandler,
  type HttpHandlerOptions,
  type HttpHeaderView,
  type HttpOpenApiDocument,
  type HttpOpenApiDocumentOptions,
} from "../src/index.js";
import {
  type HttpServerAddress,
  type HttpServerHandle,
  type ServeHttpOptions,
  serveHttp,
} from "../src/node.js";

declare const engine: Engine;

expectTypeOf(
  createHttpHandler(engine, {
    auth: { mode: "dangerously-disabled-for-development" },
  }),
).toEqualTypeOf<HttpHandler>();
expectTypeOf<HttpHandler>().toEqualTypeOf<
  (request: Request) => Promise<Response>
>();
expectTypeOf(
  createHttpOpenApiDocument(engine),
).toEqualTypeOf<HttpOpenApiDocument>();
expectTypeOf<HttpOpenApiDocumentOptions["security"]>().toEqualTypeOf<
  "bearer" | "none" | undefined
>();

expectTypeOf<HttpAuthenticationRequest>().toEqualTypeOf<{
  readonly path: string;
  readonly method: string;
  readonly headers: HttpHeaderView;
  readonly signal: AbortSignal;
}>();
expectTypeOf<HttpHeaderView>().toEqualTypeOf<{
  readonly get: (name: string) => string | null;
  readonly has: (name: string) => boolean;
}>();

const authenticate = (request: HttpAuthenticationRequest): Principal | null =>
  request.headers.get("authorization") === null ? null : { id: "user:1" };
const required: HttpAuthOptions = { mode: "required", authenticate };
const cors: HttpCorsOptions = {
  allowedOrigins: ["https://console.example"],
  allowedHeaders: ["x-api-key"],
  maxAgeSeconds: 600,
};
const options: HttpHandlerOptions = {
  basePath: "/api",
  allowedHosts: ["engine.example"],
  cors,
  maxRequestBodyBytes: 1024,
  auth: required,
};
expectTypeOf(options).toExtend<HttpHandlerOptions>();

// @ts-expect-error Authentication is a required explicit choice.
createHttpHandler(engine, {});

expectTypeOf<EngineErrorCode>().toExtend<HttpErrorCode>();
expectTypeOf<HttpAdapterErrorCode>().toExtend<HttpErrorCode>();
expectTypeOf<HttpErrorBody["error"]["code"]>().toEqualTypeOf<HttpErrorCode>();

const serveOptions: ServeHttpOptions = {
  ...options,
  host: "127.0.0.1",
  port: 0,
};
expectTypeOf(
  serveHttp(engine, serveOptions),
).resolves.toEqualTypeOf<HttpServerHandle>();
expectTypeOf<
  ReturnType<HttpServerHandle["address"]>
>().toEqualTypeOf<HttpServerAddress>();
