import type { DeployErrorCode } from "../errors.js";
import type { ProbeExpectation } from "./options.js";
import type { ProbeExchange, ProbeHttpResponse } from "./request.js";

/**
 * Fixed diagnostic text. A reason names a class of failure and never carries a
 * header value, a response body, or a transport message.
 */
export const probeReasons = Object.freeze({
  TIMEOUT: "the request exceeded the timeout",
  CONNECTION: "the connection failed",
  STATUS: "the endpoint answered with an unexpected status",
  CHALLENGE: "the challenge did not offer Bearer authentication",
  CREDENTIAL: "the endpoint rejected the credential",
  MALFORMED: "the initialize response was malformed",
} as const);

export type ProbeVerdict =
  | { readonly healthy: true }
  | {
      readonly healthy: false;
      readonly code: Extract<
        DeployErrorCode,
        "PROBE_UNREACHABLE" | "PROBE_UNHEALTHY"
      >;
      readonly status: number | undefined;
      readonly reason: string;
    };

const healthy: ProbeVerdict = { healthy: true };

function unreachable(reason: string): ProbeVerdict {
  return {
    healthy: false,
    code: "PROBE_UNREACHABLE",
    status: undefined,
    reason,
  };
}

function unhealthy(status: number, reason: string): ProbeVerdict {
  return { healthy: false, code: "PROBE_UNHEALTHY", status, reason };
}

/**
 * A challenge offers Bearer when the scheme appears as its own token, so a
 * scheme parameter that merely contains the word does not qualify.
 */
function offersBearer(challenge: string | undefined): boolean {
  if (challenge === undefined) return false;
  return /(?:^|[\s,])bearer(?=$|[\s,])/iu.test(challenge);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads the data payloads of a Server-Sent Events body. The adapter answers
 * `initialize` as JSON, but the same route may be framed as an event stream by
 * another conformant deployment, so both framings are understood.
 */
function parseEventStream(text: string): unknown {
  let data: string[] = [];
  for (const line of `${text}\n\n`.split(/\r\n|\r|\n/u)) {
    if (line === "") {
      if (data.length > 0) {
        const message = parseJson(data.join("\n"));
        if (isRecord(message)) return message;
        data = [];
      }
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const value = line.slice("data:".length);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return undefined;
}

function parseProtocolMessage(response: ProbeHttpResponse): unknown {
  const mediaType = response.contentType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === "text/event-stream") return parseEventStream(response.body);
  const parsed = parseJson(response.body);
  if (parsed !== undefined) return parsed;
  // A body framed as events despite its media type is still readable.
  return response.body.includes("data:")
    ? parseEventStream(response.body)
    : undefined;
}

/**
 * A valid `initialize` result: one JSON-RPC 2.0 response carrying a result
 * object that names the protocol revision it negotiated, and no error.
 */
function isInitializeResult(response: ProbeHttpResponse): boolean {
  if (response.truncated) return false;
  const message = parseProtocolMessage(response);
  if (!isRecord(message)) return false;
  if (message.jsonrpc !== "2.0") return false;
  if (message.error !== undefined) return false;
  const result = message.result;
  if (!isRecord(result)) return false;
  const protocolVersion = result.protocolVersion;
  return typeof protocolVersion === "string" && protocolVersion.length > 0;
}

/**
 * Decides whether the observed exchange satisfies the expectation.
 *
 * `alive` accepts the authentication challenge deliberately: it proves the
 * adapter's boundary is serving without requiring the probe to hold a
 * credential. A 403 is never healthy, because a Host or Origin rejection would
 * reject real clients too.
 */
export function classifyProbeExchange(
  expect: ProbeExpectation,
  exchange: ProbeExchange,
): ProbeVerdict {
  if (exchange.outcome === "timeout") return unreachable(probeReasons.TIMEOUT);
  if (exchange.outcome === "connection-failure") {
    return unreachable(probeReasons.CONNECTION);
  }
  if (exchange.status === 401) {
    if (expect === "ready") {
      return unhealthy(exchange.status, probeReasons.CREDENTIAL);
    }
    return offersBearer(exchange.challenge)
      ? healthy
      : unhealthy(exchange.status, probeReasons.CHALLENGE);
  }
  if (exchange.status === 200) {
    return isInitializeResult(exchange)
      ? healthy
      : unhealthy(exchange.status, probeReasons.MALFORMED);
  }
  return unhealthy(exchange.status, probeReasons.STATUS);
}
