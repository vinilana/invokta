// Preloaded with --import so every outbound network entry point is replaced
// before the toolkit is loaded. Each guard records the attempt and throws, so a
// command that opened a connection is observable as both a recorded name and a
// failed run rather than as a silently tolerated call.
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const attempts = [];
globalThis.__INVOKTA_DEPLOY_NETWORK_ATTEMPTS__ = attempts;

function guard(name) {
  return function forbidNetworkAccess() {
    attempts.push(name);
    throw new Error(`DEPLOY_NETWORK_ACCESS_FORBIDDEN:${name}`);
  };
}

Object.defineProperties(globalThis, {
  fetch: {
    configurable: true,
    value: guard("fetch"),
    writable: true,
  },
  WebSocket: {
    configurable: true,
    value: class ForbiddenWebSocket {
      constructor() {
        guard("WebSocket")();
      }
    },
    writable: true,
  },
});

http.get = guard("http.get");
http.request = guard("http.request");
http.Agent.prototype.createConnection = guard("http.Agent.createConnection");
https.get = guard("https.get");
https.request = guard("https.request");
https.Agent.prototype.createConnection = guard("https.Agent.createConnection");
http2.connect = guard("http2.connect");
net.connect = guard("net.connect");
net.createConnection = guard("net.createConnection");
net.Socket.prototype.connect = guard("net.Socket.connect");
tls.connect = guard("tls.connect");
tls.TLSSocket.prototype.connect = guard("tls.TLSSocket.connect");
dgram.createSocket = guard("dgram.createSocket");

const resolvers = [
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
];
for (const method of resolvers) {
  dns[method] = guard(`dns.${method}`);
  dnsPromises[method] = guard(`dnsPromises.${method}`);
}

syncBuiltinESMExports();

// A sentinel that failed to install would let every later assertion pass
// vacuously, so a representative guard of each transport proves it throws
// before anything is measured.
const selfProbes = [
  ["fetch", () => fetch("https://example.invalid")],
  ["WebSocket", () => new WebSocket("wss://example.invalid")],
  ["http.request", () => http.request("http://example.invalid")],
  ["https.request", () => https.request("https://example.invalid")],
  ["http2.connect", () => http2.connect("https://example.invalid")],
  ["net.connect", () => net.connect(80, "example.invalid")],
  ["tls.connect", () => tls.connect(443, "example.invalid")],
  ["dgram.createSocket", () => dgram.createSocket("udp4")],
  ["dns.lookup", () => dns.lookup("example.invalid", () => undefined)],
];

for (const [name, probe] of selfProbes) {
  let thrown;
  try {
    probe();
  } catch (error) {
    thrown = error;
  }
  if (
    !(thrown instanceof Error) ||
    !thrown.message.startsWith("DEPLOY_NETWORK_ACCESS_FORBIDDEN:")
  ) {
    throw new Error(`NETWORK_SENTINEL_SELF_PROBE_FAILED:${name}`);
  }
}

attempts.length = 0;
