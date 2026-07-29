import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const commandAttempts = [];
const commandGuards = [];
const networkAttempts = [];
const networkGuards = [];

function guard(attempts, label) {
  return function forbiddenInstallerIo() {
    attempts.push(label);
    throw new Error(`INSTALLER_IO_FORBIDDEN:${label}`);
  };
}

function installGuard(target, method, attempts, guards, prefix) {
  if (typeof target[method] !== "function") return;
  const label = `${prefix}.${method}`;
  target[method] = guard(attempts, label);
  guards.push(label);
}

for (const method of [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]) {
  installGuard(
    childProcess,
    method,
    commandAttempts,
    commandGuards,
    "child_process",
  );
}
installGuard(
  childProcess.ChildProcess.prototype,
  "spawn",
  commandAttempts,
  commandGuards,
  "ChildProcess.prototype",
);

Object.defineProperties(globalThis, {
  fetch: {
    configurable: true,
    value: guard(networkAttempts, "global.fetch"),
    writable: true,
  },
  WebSocket: {
    configurable: true,
    value: class ForbiddenWebSocket {
      constructor() {
        guard(networkAttempts, "global.WebSocket")();
      }
    },
    writable: true,
  },
});
networkGuards.push("global.fetch", "global.WebSocket");

for (const [target, prefix, methods] of [
  [http, "http", ["get", "request"]],
  [https, "https", ["get", "request"]],
  [http2, "http2", ["connect"]],
  [net, "net", ["connect", "createConnection"]],
  [tls, "tls", ["connect"]],
  [dgram, "dgram", ["createSocket"]],
  [
    dns,
    "dns",
    [
      "lookup",
      "lookupService",
      "resolve",
      "resolve4",
      "resolve6",
      "resolveAny",
      "resolveCaa",
      "resolveCname",
      "resolveMx",
      "resolveNaptr",
      "resolveNs",
      "resolvePtr",
      "resolveSoa",
      "resolveSrv",
      "resolveTxt",
      "reverse",
    ],
  ],
  [
    dnsPromises,
    "dns.promises",
    [
      "lookup",
      "lookupService",
      "resolve",
      "resolve4",
      "resolve6",
      "resolveAny",
      "resolveCaa",
      "resolveCname",
      "resolveMx",
      "resolveNaptr",
      "resolveNs",
      "resolvePtr",
      "resolveSoa",
      "resolveSrv",
      "resolveTxt",
      "reverse",
    ],
  ],
]) {
  for (const method of methods) {
    installGuard(target, method, networkAttempts, networkGuards, prefix);
  }
}
installGuard(
  http.Agent.prototype,
  "createConnection",
  networkAttempts,
  networkGuards,
  "http.Agent.prototype",
);
installGuard(
  https.Agent.prototype,
  "createConnection",
  networkAttempts,
  networkGuards,
  "https.Agent.prototype",
);
installGuard(
  net.Socket.prototype,
  "connect",
  networkAttempts,
  networkGuards,
  "net.Socket.prototype",
);
installGuard(
  tls.TLSSocket.prototype,
  "connect",
  networkAttempts,
  networkGuards,
  "tls.TLSSocket.prototype",
);

syncBuiltinESMExports();

Object.defineProperty(globalThis, "__AI_ENGINE_TRANSACTION_LOCK_IO_AUDIT__", {
  configurable: false,
  enumerable: false,
  value: {
    commandAttempts,
    commandGuards,
    networkAttempts,
    networkGuards,
  },
  writable: false,
});
