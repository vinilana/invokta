import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { probeProtocolVersion } from "../probe-contract.js";

export const oauthInspectionMaxResponseBytes = 256 * 1024;

export interface OAuthInspectionRequest {
  readonly url: URL;
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly deadline: number;
}

export interface OAuthInspectionHttpResponse {
  readonly outcome: "response";
  readonly status: number;
  readonly challenge: string | undefined;
  readonly contentType: string | undefined;
  readonly location: string | undefined;
  readonly body: string;
}

export type OAuthInspectionExchange =
  | OAuthInspectionHttpResponse
  | { readonly outcome: "deadline" }
  | { readonly outcome: "connection-failure" }
  | { readonly outcome: "response-too-large" }
  | { readonly outcome: "invalid-utf8" };

function firstHeaderValue(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : (value as string);
}

/**
 * Sends one credential-free request within the inspection's shared deadline.
 * Redirects are surfaced to the classifier rather than followed, and every
 * response is bounded before it is decoded as strict UTF-8.
 */
export function sendOAuthInspectionRequest(
  input: OAuthInspectionRequest,
): Promise<OAuthInspectionExchange> {
  return new Promise<OAuthInspectionExchange>((resolve) => {
    const remainingMs = input.deadline - Date.now();
    if (remainingMs <= 0) {
      resolve({ outcome: "deadline" });
      return;
    }
    const secure = input.url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const hostname = input.url.hostname.startsWith("[")
      ? input.url.hostname.slice(1, -1)
      : input.url.hostname;
    const port =
      input.url.port === "" ? (secure ? 443 : 80) : Number(input.url.port);
    const body = Buffer.from(input.body ?? "", "utf8");
    let settled = false;
    let timedOut = false;
    let request: ClientRequest | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ outcome: "deadline" });
    }, remainingMs);

    function finish(exchange: OAuthInspectionExchange): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(exchange);
    }

    function fail(): void {
      finish({ outcome: timedOut ? "deadline" : "connection-failure" });
    }

    function receive(response: IncomingMessage): void {
      const declared = firstHeaderValue(response.headers["content-length"]);
      if (
        declared !== undefined &&
        /^\d+$/u.test(declared) &&
        Number(declared) > oauthInspectionMaxResponseBytes
      ) {
        finish({ outcome: "response-too-large" });
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > oauthInspectionMaxResponseBytes) {
          finish({ outcome: "response-too-large" });
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          );
        } catch {
          finish({ outcome: "invalid-utf8" });
          return;
        }
        finish({
          outcome: "response",
          status: response.statusCode ?? 0,
          challenge: firstHeaderValue(response.headers["www-authenticate"]),
          contentType: firstHeaderValue(response.headers["content-type"]),
          location: firstHeaderValue(response.headers.location),
          body: decoded,
        });
      });
      response.once("aborted", fail);
      response.once("error", fail);
    }

    try {
      request = send(
        {
          protocol: input.url.protocol,
          hostname,
          port,
          path: `${input.url.pathname}${input.url.search}`,
          method: input.method,
          agent: false,
          headers: {
            accept: "application/json",
            "mcp-protocol-version": probeProtocolVersion,
            connection: "close",
            ...(input.method === "POST"
              ? {
                  "content-type": "application/json",
                  "content-length": String(body.byteLength),
                }
              : {}),
          },
        },
        receive,
      );
      request.once("error", fail);
      request.end(input.method === "POST" ? body : undefined);
    } catch {
      finish({ outcome: "connection-failure" });
    }
  });
}
