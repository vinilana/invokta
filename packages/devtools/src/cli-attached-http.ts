import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const attachedCliConnectionBodyLimitBytes = 1024 * 1024;
export const attachedCliRunBodyLimitBytes = 10 * 1024 * 1024;
// One origin serves both workbenches, and a browser keeps one cookie per
// name: each workbench needs its own, or switching between them silently
// replaces the other's session.
export const attachedCliSessionCookieName = "invokta_devtools_cli_session";
export const attachedCliCsrfHeaderName = "x-invokta-csrf";

const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export function attachedCliSecurityHeaders(): Readonly<Record<string, string>> {
  return {
    "content-security-policy": contentSecurityPolicy,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
}

export function sendAttachedCliJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    ...attachedCliSecurityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function sendAttachedCliError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendAttachedCliJson(response, status, { code, message });
}

export function sendAttachedCliErrorBeforeBodyConsumption(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  response.shouldKeepAlive = false;
  request.once("error", () => undefined);
  request.resume();
  response.once("finish", () => {
    if (!request.complete && !request.destroyed) request.destroy();
  });
  sendAttachedCliJson(
    response,
    status,
    { code, message },
    { connection: "close" },
  );
}

function rawHeaderValues(
  request: IncomingMessage,
  expectedName: string,
): readonly string[] {
  const values: string[] = [];
  const lower = expectedName.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() === lower && value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

export function oneAttachedCliRawHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const values = rawHeaderValues(request, name);
  return values.length === 1 ? values[0] : undefined;
}

export function equalAttachedCliOpaqueToken(
  actual: string | undefined,
  expected: string,
): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function parseAttachedCliSessionCookie(
  value: string,
): string | undefined {
  let selected: string | undefined;
  for (const pair of value.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== attachedCliSessionCookieName) continue;
    if (selected !== undefined) return undefined;
    const candidate = pair.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{32,}$/.test(candidate)) return undefined;
    selected = candidate;
  }
  return selected;
}

async function readBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<{ readonly ok: boolean; readonly body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onData = (value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > limitBytes) {
        settled = true;
        cleanup();
        request.once("error", () => undefined);
        request.resume();
        resolve({ ok: false, body: Buffer.alloc(0) });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: true, body: Buffer.concat(chunks) });
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = (): void => onError(new Error("Request aborted."));
    if (request.aborted || request.destroyed) {
      onAborted();
      return;
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    if (request.aborted || request.destroyed) onAborted();
    else if (request.readableEnded) onEnd();
  });
}

function declaredBodyExceedsLimit(
  request: IncomingMessage,
  limitBytes: number,
): boolean {
  const value = request.headers["content-length"];
  return (
    typeof value === "string" &&
    /^\d+$/u.test(value) &&
    BigInt(value) > BigInt(limitBytes)
  );
}

function parseStrictJson(body: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function isAttachedCliRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readAttachedCliJsonMutation(
  request: IncomingMessage,
  response: ServerResponse,
  limitBytes: number,
  tooLargeMessage: string,
): Promise<unknown | undefined> {
  if (oneAttachedCliRawHeader(request, "content-type") !== "application/json") {
    sendAttachedCliErrorBeforeBodyConsumption(
      request,
      response,
      400,
      "INVALID_REQUEST",
      "The request must contain exact JSON content.",
    );
    return undefined;
  }
  if (declaredBodyExceedsLimit(request, limitBytes)) {
    sendAttachedCliErrorBeforeBodyConsumption(
      request,
      response,
      413,
      "LIMIT_EXCEEDED",
      tooLargeMessage,
    );
    return undefined;
  }
  const read = await readBody(request, limitBytes);
  if (!read.ok) {
    sendAttachedCliErrorBeforeBodyConsumption(
      request,
      response,
      413,
      "LIMIT_EXCEEDED",
      tooLargeMessage,
    );
    return undefined;
  }
  return parseStrictJson(read.body);
}

export function sendAttachedCliControllerError(
  response: ServerResponse,
  error: unknown,
): void {
  const code =
    isAttachedCliRecord(error) && typeof error.code === "string"
      ? error.code
      : undefined;
  switch (code) {
    case "INVALID_TARGET":
    case "ENVIRONMENT_VALUE_MISSING":
      sendAttachedCliError(
        response,
        400,
        code,
        code === "INVALID_TARGET"
          ? "The CLI target descriptor is invalid."
          : "A required environment value is missing.",
      );
      return;
    case "TARGET_BUSY":
    case "NOT_CONNECTED":
      sendAttachedCliError(
        response,
        409,
        code,
        code === "TARGET_BUSY"
          ? "Another target or CLI verb is already active."
          : "No CLI target is connected for this browser session.",
      );
      return;
    case "LIMIT_EXCEEDED":
      sendAttachedCliError(
        response,
        413,
        code,
        "The configured CLI limit was exceeded.",
      );
      return;
    case "TIMEOUT":
      sendAttachedCliError(response, 504, code, "The CLI operation timed out.");
      return;
    case "SPAWN_FAILED":
    case "CONNECTION_FAILED":
    case "PROTOCOL_ERROR":
      sendAttachedCliError(
        response,
        502,
        code,
        "The CLI target operation failed.",
      );
      return;
    default:
      sendAttachedCliError(
        response,
        409,
        "NOT_CONNECTED",
        "No CLI target is connected for this browser session.",
      );
  }
}
