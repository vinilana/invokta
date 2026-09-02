import { afterEach, describe, expect, it } from "vitest";

import { runProbe } from "../src/probe.js";
import {
  initializeResult,
  type ProbeStub,
  type ProbeStubResponder,
  reserveClosedPort,
  respondNever,
  respondWithBearerChallenge,
  respondWithBody,
  respondWithJsonInitializeResult,
  respondWithSseInitializeResult,
  respondWithStatus,
  startProbeStub,
} from "./support/probe-server.js";
import { createTestContext } from "./support/test-context.js";

const secret = "sentinel-token-that-must-never-be-echoed";
const openStubs: ProbeStub[] = [];

afterEach(async () => {
  await Promise.all(openStubs.splice(0).map((stub) => stub.close()));
});

async function stub(respond: ProbeStubResponder): Promise<ProbeStub> {
  const started = await startProbeStub(respond);
  openStubs.push(started);
  return started;
}

async function probe(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
) {
  const harness = createTestContext({ env });
  const exitCode = await runProbe(args, harness.context);
  return { exitCode, stdout: harness.stdout, stderr: harness.stderr };
}

function unreachable(url: string, reason: string): string {
  return `PROBE_UNREACHABLE: The MCP endpoint could not be reached.
  url: ${url}
  reason: ${reason}
`;
}

function unhealthy(url: string, status: number, reason: string): string {
  return `PROBE_UNHEALTHY: The MCP endpoint is not healthy.
  url: ${url}
  status: ${String(status)}
  reason: ${reason}
`;
}

describe("runProbe request shape", () => {
  it("sends exactly one pinned MCP initialize POST", async () => {
    const endpoint = await stub(respondWithJsonInitializeResult);

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(0);
    expect(endpoint.requests).toHaveLength(1);
    const [request] = endpoint.requests;
    expect(request?.method).toBe("POST");
    expect(request?.target).toBe("/mcp");
    expect(request?.accept).toBe("application/json, text/event-stream");
    expect(request?.contentType).toBe("application/json");
    expect(request?.connection).toBe("close");
    expect(request?.hostHeaderCount).toBe(1);
    expect(request?.host).toBe(`127.0.0.1:${String(endpoint.port)}`);
    expect(request?.authorization).toBeUndefined();
    expect(JSON.parse(request?.body ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "invokta-deploy-probe", version: "1" },
      },
    });
  });

  it("sends the request to a mounted path exactly as written", async () => {
    const endpoint = await stub(respondWithJsonInitializeResult);
    const mounted = endpoint.url.replace(/\/mcp$/u, "/e/orders/mcp");

    const result = await probe(["--url", mounted]);

    expect(result.exitCode).toBe(0);
    expect(endpoint.requests.map((request) => request.target)).toEqual([
      "/e/orders/mcp",
    ]);
  });

  it("declares the body length instead of streaming it in chunks", async () => {
    const endpoint = await stub(respondWithJsonInitializeResult);

    await probe(["--url", endpoint.url]);

    const [request] = endpoint.requests;
    expect(request?.contentLength).toBe(
      String(Buffer.byteLength(request?.body ?? "", "utf8")),
    );
  });

  it("sends the overridden Host header while connecting to loopback", async () => {
    const endpoint = await stub(respondWithJsonInitializeResult);

    const result = await probe([
      "--url",
      endpoint.url,
      "--host-header",
      "engine.example",
    ]);

    expect(result.exitCode).toBe(0);
    expect(endpoint.requests[0]?.host).toBe("engine.example");
    expect(endpoint.requests[0]?.hostHeaderCount).toBe(1);
  });

  it("writes nothing at all when the endpoint is healthy", async () => {
    const endpoint = await stub(respondWithJsonInitializeResult);

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([]);
  });
});

describe("runProbe alive classification", () => {
  it("accepts a Bearer challenge", async () => {
    const endpoint = await stub(respondWithBearerChallenge);

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(endpoint.requests).toHaveLength(1);
  });

  it("accepts a Bearer challenge that carries resource metadata", async () => {
    const endpoint = await stub(
      respondWithStatus(401, {
        "www-authenticate":
          'Bearer resource_metadata="https://engine.example/.well-known/oauth-protected-resource/mcp"',
      }),
    );

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(0);
  });

  it("accepts a JSON initialize result", async () => {
    const endpoint = await stub(respondWithJsonInitializeResult);

    const result = await probe(["--url", endpoint.url, "--expect", "alive"]);

    expect(result.exitCode).toBe(0);
  });

  it("accepts an initialize result framed as Server-Sent Events", async () => {
    const endpoint = await stub(respondWithSseInitializeResult);

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(0);
  });

  it("rejects a 401 without a challenge", async () => {
    const endpoint = await stub(respondWithStatus(401));

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      unhealthy(
        endpoint.url,
        401,
        "the challenge did not offer Bearer authentication",
      ),
    ]);
  });

  it("rejects a 401 challenging another scheme", async () => {
    const endpoint = await stub(
      respondWithStatus(401, { "www-authenticate": 'Basic realm="engine"' }),
    );

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(1);
  });

  it.each([
    [403, "a Host or Origin rejection"],
    [404, "a missing route"],
    [405, "a rejected method"],
    [415, "a rejected media type"],
    [500, "a server failure"],
    [502, "a gateway failure"],
    [503, "an unavailable server"],
  ])("rejects HTTP %i, which reports %s", async (status) => {
    const endpoint = await stub(respondWithStatus(status));

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      unhealthy(
        endpoint.url,
        status,
        "the endpoint answered with an unexpected status",
      ),
    ]);
    expect(endpoint.requests).toHaveLength(1);
  });

  it.each([
    ["an unparseable body", "not json at all"],
    ["an empty body", ""],
    ["a JSON-RPC error", '{"jsonrpc":"2.0","id":1,"error":{"code":-32000}}'],
    ["a missing result", '{"jsonrpc":"2.0","id":1}'],
    ["a null result", '{"jsonrpc":"2.0","id":1,"result":null}'],
    ["a non-object result", '{"jsonrpc":"2.0","id":1,"result":"ok"}'],
    [
      "a result without a protocol version",
      '{"jsonrpc":"2.0","id":1,"result":{}}',
    ],
    [
      "a missing JSON-RPC version",
      '{"id":1,"result":{"protocolVersion":"2025-11-25"}}',
    ],
    [
      "a JSON array",
      '[{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"x"}}]',
    ],
  ])("rejects HTTP 200 carrying %s", async (_label, body) => {
    const endpoint = await stub(respondWithBody(body));

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      unhealthy(endpoint.url, 200, "the initialize response was malformed"),
    ]);
  });

  it("rejects an event stream that carries no JSON-RPC result", async () => {
    const endpoint = await stub(
      respondWithBody("event: message\ndata: nope\n\n", "text/event-stream"),
    );

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(1);
  });
});

describe("runProbe ready classification", () => {
  it("accepts a JSON initialize result", async () => {
    const endpoint = await stub(respondWithJsonInitializeResult);

    const result = await probe(["--url", endpoint.url, "--expect", "ready"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
  });

  it("rejects a Bearer challenge", async () => {
    const endpoint = await stub(respondWithBearerChallenge);

    const result = await probe(["--url", endpoint.url, "--expect", "ready"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      unhealthy(endpoint.url, 401, "the endpoint rejected the credential"),
    ]);
  });

  it("sends the bearer token read from the environment", async () => {
    const endpoint = await stub((request, response) => {
      if (request.authorization === `Bearer ${secret}`) {
        respondWithJsonInitializeResult(request, response);
        return;
      }
      respondWithBearerChallenge(request, response);
    });

    const result = await probe(
      [
        "--url",
        endpoint.url,
        "--expect",
        "ready",
        "--bearer-env",
        "PROBE_TOKEN",
      ],
      { PROBE_TOKEN: secret },
    );

    expect(result.exitCode).toBe(0);
    expect(endpoint.requests[0]?.authorization).toBe(`Bearer ${secret}`);
  });

  it("keeps the token out of every diagnostic when the endpoint is unhealthy", async () => {
    const endpoint = await stub(respondWithStatus(500));

    const result = await probe(
      [
        "--url",
        endpoint.url,
        "--expect",
        "ready",
        "--bearer-env",
        "PROBE_TOKEN",
      ],
      { PROBE_TOKEN: secret },
    );

    expect(result.exitCode).toBe(1);
    expect(endpoint.requests[0]?.authorization).toBe(`Bearer ${secret}`);
    expect(result.stdout.join("")).not.toContain(secret);
    expect(result.stderr.join("")).not.toContain(secret);
    expect(result.stderr.join("").toLowerCase()).not.toContain("authorization");
  });

  it("keeps the token out of a thrown failure when the connection fails", async () => {
    const url = `http://127.0.0.1:${String(await reserveClosedPort())}/mcp`;

    const result = await probe(
      ["--url", url, "--expect", "ready", "--bearer-env", "PROBE_TOKEN"],
      { PROBE_TOKEN: secret },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("")).not.toContain(secret);
  });
});

describe("runProbe transport failures", () => {
  it("reports a refused connection as unreachable", async () => {
    const url = `http://127.0.0.1:${String(await reserveClosedPort())}/mcp`;

    const result = await probe(["--url", url]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([unreachable(url, "the connection failed")]);
  });

  it("gives up on an endpoint that never answers", async () => {
    const endpoint = await stub(respondNever);
    const started = Date.now();

    const result = await probe(["--url", endpoint.url, "--timeout-ms", "120"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      unreachable(endpoint.url, "the request exceeded the timeout"),
    ]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(endpoint.requests).toHaveLength(1);
  });

  it("does not retry after a failure", async () => {
    const endpoint = await stub(respondWithStatus(503));

    await probe(["--url", endpoint.url]);
    await probe(["--url", endpoint.url]);

    expect(endpoint.requests).toHaveLength(2);
  });

  it("never follows a redirect", async () => {
    const target = await stub(respondWithJsonInitializeResult);
    const endpoint = await stub(
      respondWithStatus(302, { location: target.url }),
    );

    const result = await probe(["--url", endpoint.url]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toEqual([
      unhealthy(
        endpoint.url,
        302,
        "the endpoint answered with an unexpected status",
      ),
    ]);
    expect(endpoint.requests).toHaveLength(1);
    expect(target.requests).toHaveLength(0);
  });

  it("rejects an oversized response body", async () => {
    const endpoint = await stub((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        `{"jsonrpc":"2.0","id":1,"padding":"${"x".repeat(2 * 1024 * 1024)}","result":${JSON.stringify(initializeResult.result)}}`,
      );
    });

    const result = await probe(["--url", endpoint.url, "--timeout-ms", "5000"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([
      unhealthy(endpoint.url, 200, "the initialize response was malformed"),
    ]);
  });
});
