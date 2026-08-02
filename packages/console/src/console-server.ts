/**
 * The console's HTTP surface.
 *
 * Loopback only, one page, two endpoints, and no state of its own. Every
 * request passes the transport checks in `session.ts` before a token is even
 * compared, and the document response carries no inventory data, so a page
 * loaded without the token learns nothing.
 */

import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  type ConsoleAction,
  type ConsoleService,
  consoleActions,
} from "./console-service.js";
import { bearerToken, type ConsoleSession, checkTransport } from "./session.js";
import { toWireInventory } from "./wire.js";

const pageUrl = new URL("../web/index.html", import.meta.url);
const maximumRequestBytes = 64 * 1024;

export interface CreateConsoleServerOptions {
  readonly service: ConsoleService;
  readonly session: ConsoleSession;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maximumRequestBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function actionRequest(payload: unknown) {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const action = record.action;
  const engineId = record.engineId;
  const targetIds = record.targetIds;
  if (
    typeof action !== "string" ||
    !consoleActions.includes(action as ConsoleAction) ||
    typeof engineId !== "string" ||
    engineId === "" ||
    !Array.isArray(targetIds) ||
    targetIds.length === 0 ||
    targetIds.some((id) => typeof id !== "string" || id === "")
  ) {
    return undefined;
  }
  return {
    action: action as ConsoleAction,
    engineId,
    targetIds: targetIds as string[],
  };
}

export function createConsoleServer(
  options: CreateConsoleServerOptions,
): Server {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      send(response, 500, { error: "The console request failed." });
    });
  });

  function port(): number {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const rejection = checkTransport({
      port: port(),
      host: header(request, "host"),
      origin: header(request, "origin"),
      fetchSite: header(request, "sec-fetch-site"),
    });
    if (rejection !== undefined) {
      send(response, 403, { error: `The request was rejected: ${rejection}.` });
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      if (!options.session.matches(url.searchParams.get("token"))) {
        response.writeHead(403, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(
          "Invalid session token. Reopen the URL that invokta-console printed.\n",
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      response.end(await readFile(pageUrl));
      return;
    }

    if (
      !options.session.matches(bearerToken(header(request, "authorization")))
    ) {
      send(response, 403, { error: "The session token is invalid." });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/inventory") {
      const inventory = await options.service.read({
        refresh: url.searchParams.get("refresh") === "1",
      });
      send(response, 200, toWireInventory(inventory));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/action") {
      let payload: unknown;
      try {
        payload = await readBody(request);
      } catch {
        send(response, 400, { error: "The request body is invalid." });
        return;
      }
      const parsed = actionRequest(payload);
      if (parsed === undefined) {
        send(response, 400, { error: "The requested action is invalid." });
        return;
      }
      const result = await options.service.apply(
        parsed as Parameters<ConsoleService["apply"]>[0],
      );
      if (result.kind === "busy") {
        send(response, 409, {
          error: "Another change is already being applied.",
        });
        return;
      }
      if (result.kind === "rejected") {
        send(response, 422, { error: result.message, code: result.code });
        return;
      }
      send(response, 200, { results: result.results });
      return;
    }

    send(response, 404, { error: "Not found." });
  }

  return server;
}
