import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";

import {
  createEngine,
  defineCapability,
  type ExecutionContext,
} from "@invokta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type HttpServerHandle, serveHttp } from "../src/node.js";

const openServers: HttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function createNodeEngine(
  observe: (context: ExecutionContext) => void = () => undefined,
) {
  return createEngine({
    name: "node-http-engine",
    version: "0.1.0",
    capabilities: {
      "support.echo": defineCapability({
        description: "Echoes a value.",
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string(), source: z.string() }),
        access: "public",
        async run({ input, context }) {
          return { value: input.value, source: context.source };
        },
      }),
      "support.wait": defineCapability({
        description: "Waits for cancellation.",
        input: z.object({}),
        output: z.object({}),
        access: "public",
        async run({ context }) {
          observe(context);
          return waitForAbort(context.signal);
        },
      }),
    },
  });
}

async function start(
  engine = createNodeEngine(),
  options: Partial<Parameters<typeof serveHttp>[1]> = {},
): Promise<HttpServerHandle> {
  const server = await serveHttp(engine, {
    port: 0,
    auth: { mode: "dangerously-disabled-for-development" },
    ...options,
  });
  openServers.push(server);
  return server;
}

function url(server: HttpServerHandle, path: string): string {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

function rawRequest(server: HttpServerHandle, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(server.address().port, "127.0.0.1");
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => resolve(received));
    socket.write(text);
  });
}

describe("serveHttp", () => {
  it("serves the Web-standard handler on the loopback default", async () => {
    const server = await start();

    expect(server.address()).toEqual({
      host: "127.0.0.1",
      port: expect.any(Number),
    });
    const listed = await fetch(url(server, "/capabilities"));
    expect(listed.status).toBe(200);
    expect(listed.headers.get("content-type")).toBe("application/json");
    expect(
      ((await listed.json()) as { readonly capabilities: unknown[] })
        .capabilities,
    ).toHaveLength(2);

    const invoked = await fetch(url(server, "/capabilities/support.echo"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    });
    expect(invoked.status).toBe(200);
    expect(await invoked.json()).toEqual({ value: "hello", source: "http" });
  });

  it("requires a host allowlist for a non-loopback bind", async () => {
    await expect(
      serveHttp(createNodeEngine(), {
        host: "0.0.0.0",
        port: 0,
        auth: { mode: "dangerously-disabled-for-development" },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("validates handler options before listening", async () => {
    await expect(
      serveHttp(createNodeEngine(), {
        port: 0,
        basePath: "api",
        auth: { mode: "dangerously-disabled-for-development" },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("applies the handler host allowlist to the raw Host header", async () => {
    const server = await start();

    const response = await rawRequest(
      server,
      "GET /capabilities HTTP/1.1\r\nHost: engine.example\r\nConnection: close\r\n\r\n",
    );

    expect(response).toMatch(/^HTTP\/1\.1 403 /u);
    expect(response).toContain('"HOST_NOT_ALLOWED"');
  });

  it("rejects duplicate Host headers and request-target aliases", async () => {
    const server = await start();

    for (const head of [
      "GET /capabilities HTTP/1.1\r\nHost: localhost\r\nHost: engine.example\r\n",
      "GET http://localhost/capabilities HTTP/1.1\r\nHost: localhost\r\n",
      "GET //evil.example/capabilities HTTP/1.1\r\nHost: localhost\r\n",
      "GET /\\evil.example/capabilities HTTP/1.1\r\nHost: localhost\r\n",
      "GET /capabilities HTTP/1.1\r\nHost: user@localhost\r\n",
    ]) {
      const response = await rawRequest(
        server,
        `${head}Connection: close\r\n\r\n`,
      );
      expect(response, head).toMatch(/^HTTP\/1\.1 400 /u);
      expect(response).toContain('"INVALID_REQUEST"');
    }
  });

  it("closes the connection when the body was not consumed", async () => {
    const server = await start(createNodeEngine(), { maxRequestBodyBytes: 8 });

    const status = await new Promise<{
      readonly status: number | undefined;
      readonly connection: string | undefined;
    }>((resolve, reject) => {
      const request = httpRequest(
        url(server, "/capabilities/support.echo"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          response.resume();
          request.destroy();
          resolve({
            status: response.statusCode,
            connection: response.headers.connection,
          });
        },
      );
      request.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
          reject(error);
        }
      });
      request.write(JSON.stringify({ value: "x".repeat(64) }));
    });

    expect(status).toEqual({ status: 413, connection: "close" });
  });

  it("aborts the invocation when the client disconnects", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const server = await start(
      createNodeEngine((context) => started.resolve(context.signal)),
    );

    const request = httpRequest(url(server, "/capabilities/support.wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    request.once("error", () => undefined);
    request.end("{}");
    const signal = await started.promise;
    request.destroy();

    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("closes idempotently and aborts active requests", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const server = await start(
      createNodeEngine((context) => started.resolve(context.signal)),
    );

    const pending = fetch(url(server, "/capabilities/support.wait"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
    const signal = await started.promise;

    const first = server.close();
    expect(server.close()).toBe(first);
    await first;
    await pending;

    expect(signal.aborted).toBe(true);
  });
});
