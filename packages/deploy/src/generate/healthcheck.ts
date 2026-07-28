import type { HttpDeployManifest } from "../manifest.js";
import {
  probeProtocolVersion,
  probeTimeoutDefaultMs,
  probeTimeoutText,
} from "../probe-contract.js";
import { generatedFileMarkerLine } from "./marker.js";

export interface HealthcheckInput {
  readonly manifest: HttpDeployManifest;
}

// The generated script implements the same contract as `probe`, so it pins the
// revision and the deadline the probe pins rather than values of its own.
export const healthcheckProtocolVersion = probeProtocolVersion;
export const healthcheckTimeoutMs = probeTimeoutDefaultMs;
export const healthcheckTimeoutText = probeTimeoutText;

// The body is raw so its escape sequences reach the generated file unchanged.
const healthcheckBody = String.raw`
const requestPath = "/mcp";
const requestId = "ai-engine-deploy-healthcheck";
const clientName = "ai-engine-deploy-healthcheck";
const maxResponseBytes = 65536;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPort(environment) {
  const declared = (
    environment.AI_ENGINE_HTTP_PORT ??
    environment.PORT ??
    ""
  ).trim();
  if (declared === "") return defaultPort;
  const port = Number(declared);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

// The adapter validates the raw Host header and ignores forwarded ones, so a
// container that binds every interface only admits its public hosts. The first
// allowed host is therefore the Host this loopback request must present.
function readHostHeader(environment, port) {
  const declared = environment.AI_ENGINE_HTTP_ALLOWED_HOSTS ?? "";
  const first = declared
    .split(",")
    .map((item) => item.trim())
    .find((item) => item !== "");
  return first ?? "127.0.0.1:" + String(port);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The adapter answers initialize as JSON, but the same route may be framed as
// an event stream by another conformant deployment, so both are understood.
function decodeMessage(contentType, body) {
  const mediaType = String(contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "text/event-stream") return parseJson(body);
  const data = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line === "") {
      if (data.length > 0) break;
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length === 0 ? undefined : parseJson(data.join("\n"));
}

function headerValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined ? "" : String(value);
}

// A challenge offers Bearer when the scheme appears as its own token, so a
// scheme parameter that merely contains the word does not qualify.
function offersBearer(challenge) {
  return /(?:^|[\s,])bearer(?=$|[\s,])/iu.test(challenge);
}

// One JSON-RPC 2.0 response carrying a result object that names the protocol
// revision it negotiated, and no error.
function isInitializeResult(message) {
  if (!isRecord(message)) return false;
  if (message.jsonrpc !== "2.0") return false;
  if (message.error !== undefined) return false;
  const result = message.result;
  if (!isRecord(result)) return false;
  const negotiated = result.protocolVersion;
  return typeof negotiated === "string" && negotiated !== "";
}

// Exactly one request, no redirect, no retry, no connection reuse, and one
// deadline covering connection, transfer, and parsing.
function send(port, headers, body) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let clientRequest;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (clientRequest !== undefined) clientRequest.destroy();
      resolve(outcome);
    };
    clientRequest = request(
      {
        agent: false,
        headers,
        host: "127.0.0.1",
        method: "POST",
        path: requestPath,
        port,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= maxResponseBytes) chunks.push(chunk);
        });
        response.on("end", () => {
          settle({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
        response.on("error", () => {
          settle(undefined);
        });
      },
    );
    clientRequest.on("error", () => {
      settle(undefined);
    });
    timer = setTimeout(() => {
      settle(undefined);
    }, timeoutMs);
    clientRequest.end(body);
  });
}

// Resolves with undefined when the endpoint is healthy, otherwise with a
// reason that names no header value, no response body, and no token.
async function probe(environment) {
  const port = readPort(environment);
  if (port === undefined) return "the configured port is not a valid integer";

  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    host: readHostHeader(environment, port),
  };
  if (expectation === "ready" && bearerVariable !== null) {
    const token = environment[bearerVariable];
    if (token === undefined || token === "") {
      return "the bearer variable " + bearerVariable + " is not set";
    }
    headers.authorization = "Bearer " + token;
  }

  const body = JSON.stringify({
    id: requestId,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: clientName, version: "0" },
      protocolVersion,
    },
  });
  headers["content-length"] = String(Buffer.byteLength(body));

  const outcome = await send(port, headers, body);
  if (outcome === undefined) return "the endpoint could not be reached";
  if (outcome.status === 401) {
    if (expectation !== "alive") return "http status 401";
    const challenge = headerValue(outcome.headers["www-authenticate"]);
    if (offersBearer(challenge)) return undefined;
    return "http status 401 without a bearer challenge";
  }
  if (outcome.status !== 200) return "http status " + String(outcome.status);
  const message = decodeMessage(outcome.headers["content-type"], outcome.body);
  if (isInitializeResult(message)) return undefined;
  return "the initialize response is malformed";
}

/** Resolves with 0 when the endpoint is healthy and 1 when it is not. */
export async function runHealthcheck(environment = process.env) {
  const reason = await probe(environment);
  if (reason === undefined) return 0;
  process.stderr.write("unhealthy: " + reason + "\n");
  return 1;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = await runHealthcheck(process.env);
}
`;

/**
 * Renders the container health check. The script is self-contained: it imports
 * Node built-ins only, so it runs inside the runtime image without the
 * toolkit, the framework, or any dependency being installed.
 */
export function renderHealthcheck(input: HealthcheckInput): string {
  const { healthcheck, image } = input.manifest;
  const bearerVariable =
    healthcheck.bearerEnv === undefined
      ? "null"
      : JSON.stringify(healthcheck.bearerEnv);

  return `${generatedFileMarkerLine("line")}
//
// One bounded MCP liveness check against the local server, used by the
// container HEALTHCHECK and usable from any smoke test:
//
//   node deploy/healthcheck.mjs
//
// It exits 0 when the endpoint is healthy and 1 when it is not, and it never
// prints a header value, a response body, or a credential.

import { request } from "node:http";
import { pathToFileURL } from "node:url";

const defaultPort = ${image.port};
const expectation = ${JSON.stringify(healthcheck.expect)};
const bearerVariable = ${bearerVariable};
const protocolVersion = ${JSON.stringify(healthcheckProtocolVersion)};
const timeoutMs = ${healthcheckTimeoutMs};
${healthcheckBody}`;
}
