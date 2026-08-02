/**
 * Local HTTP surface for the console.
 *
 * The server is intentionally boring: loopback only, one random session token,
 * strict `Host` and `Origin` checks, no CORS, no static asset tree, and no
 * mutation of its own. Every write request is forwarded to the terminal gate
 * and only executed after the operator confirms it there.
 */

import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { buildInventory } from "./inventory.mjs";

const pageUrl = new URL("../web/index.html", import.meta.url);
const managementActions = new Set(["enable", "disable", "remove"]);

function tokensMatch(expected, candidate) {
  if (typeof candidate !== "string" || candidate.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function readJsonBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function describeResults(bridge, results, targets) {
  return results.map((result) => {
    const target = targets.find(({ id }) => id === result.targetId);
    return {
      targetId: result.targetId,
      displayName: target?.displayName ?? result.targetId,
      outcome: result.outcome,
      reloadHint: target?.reloadHint,
      ...(result.outcome === "failed"
        ? { code: result.code, message: bridge.describeCode(result.code) }
        : {}),
    };
  });
}

async function resolveMutation(bridge, inventory, payload) {
  const engine = inventory.descriptors.get(payload.engineId);
  if (engine === undefined) {
    throw new Error(`Unknown engine "${payload.engineId}".`);
  }
  const targetIds = Array.isArray(payload.targetIds) ? payload.targetIds : [];
  if (targetIds.length === 0) throw new Error("No target was selected.");

  if (managementActions.has(payload.action)) {
    if (targetIds.length !== 1) {
      throw new Error("Management actions operate on one target at a time.");
    }
    const views = await bridge.inspectManaged();
    const view = views.find(
      (candidate) =>
        candidate.installation.entryId === payload.engineId &&
        candidate.installation.targetId === targetIds[0],
    );
    if (view?.descriptor === undefined) {
      throw new Error(bridge.describeCode("INSTALLATION_UNAVAILABLE"));
    }
    return { descriptor: view.descriptor, targetIds };
  }

  if (payload.action !== "install") {
    throw new Error(`Unsupported action "${payload.action}".`);
  }
  // Installing re-reads the project manifest through the installer so its own
  // manifest, path-ownership, and entry-point rules decide what gets written.
  if (engine.project !== undefined) {
    return {
      descriptor: await bridge.resolveProjectDescriptor(
        engine.project.directory,
      ),
      targetIds,
    };
  }
  return { descriptor: engine.descriptor, targetIds };
}

function confirmationRequest(payload, descriptor, targetIds, inventory) {
  const names = targetIds.map(
    (id) =>
      inventory.targets.find((target) => target.id === id)?.displayName ?? id,
  );
  const transport = descriptor.server.transport;
  return {
    title: `${payload.action.toUpperCase()}  ${descriptor.server.name}`,
    lines: [
      `Clients: ${names.join(", ")}`,
      transport.type === "stdio"
        ? `Command: ${transport.command} ${transport.args.join(" ")}`
        : `Endpoint: ${transport.url}`,
      `Requested from the console at ${new Date().toISOString()}`,
    ],
    warning:
      payload.action === "remove"
        ? "This deletes the installer-owned server definition and its state record."
        : undefined,
  };
}

export function createConsoleServer({ bridge, gate, scanRoots, token }) {
  let cached;

  async function inventory({ refresh }) {
    if (refresh || cached === undefined) {
      await bridge.redetect();
      cached = await buildInventory(bridge, scanRoots);
    }
    return cached;
  }

  function publicInventory(model) {
    const { descriptors, ...rest } = model;
    return rest;
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((cause) => {
      sendJson(response, 500, {
        error: cause instanceof Error ? cause.message : "unexpected failure",
      });
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const host = request.headers.host ?? "";
    const address = server.address();
    const expectedHost = `127.0.0.1:${String(address?.port ?? 0)}`;
    if (host !== expectedHost) {
      sendJson(response, 403, { error: "unexpected host header" });
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${expectedHost}`) {
      sendJson(response, 403, { error: "unexpected origin" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      if (!tokensMatch(token, url.searchParams.get("token"))) {
        response.writeHead(403, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(
          "Invalid session token. Reopen the URL printed by invokta-manager.\n",
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      });
      response.end(await readFile(pageUrl));
      return;
    }

    const authorization = request.headers.authorization ?? "";
    if (!tokensMatch(token, authorization.replace(/^Bearer /u, ""))) {
      sendJson(response, 403, { error: "invalid session token" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/inventory") {
      const model = await inventory({
        refresh: url.searchParams.get("refresh") === "1",
      });
      sendJson(response, 200, publicInventory(model));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/action") {
      const payload = await readJsonBody(request);
      const model = await inventory({ refresh: false });
      let plan;
      try {
        plan = await resolveMutation(bridge, model, payload);
      } catch (cause) {
        sendJson(response, 400, {
          error: cause instanceof Error ? cause.message : "invalid request",
        });
        return;
      }

      const approved = await gate.request(
        confirmationRequest(payload, plan.descriptor, plan.targetIds, model),
      );
      if (!approved) {
        sendJson(response, 200, { approved: false, results: [] });
        return;
      }

      const results = await bridge.apply({
        action: payload.action,
        descriptor: plan.descriptor,
        targetIds: plan.targetIds,
      });
      cached = undefined;
      sendJson(response, 200, {
        approved: true,
        results: describeResults(bridge, results, model.targets),
      });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  }

  return server;
}
