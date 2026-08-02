import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

function forbidNetworkAccess() {
  throw new Error("INSTALLER_NETWORK_ACCESS_FORBIDDEN");
}

Object.defineProperties(globalThis, {
  fetch: {
    configurable: true,
    value: forbidNetworkAccess,
    writable: true,
  },
  WebSocket: {
    configurable: true,
    value: class ForbiddenWebSocket {
      constructor() {
        forbidNetworkAccess();
      }
    },
    writable: true,
  },
});

http.get = forbidNetworkAccess;
http.request = forbidNetworkAccess;
http.Agent.prototype.createConnection = forbidNetworkAccess;
https.get = forbidNetworkAccess;
https.request = forbidNetworkAccess;
https.Agent.prototype.createConnection = forbidNetworkAccess;
http2.connect = forbidNetworkAccess;
net.connect = forbidNetworkAccess;
net.createConnection = forbidNetworkAccess;
net.Socket.prototype.connect = forbidNetworkAccess;
tls.connect = forbidNetworkAccess;
tls.TLSSocket.prototype.connect = forbidNetworkAccess;
dgram.createSocket = forbidNetworkAccess;
dns.lookup = forbidNetworkAccess;
dns.lookupService = forbidNetworkAccess;
dns.resolve = forbidNetworkAccess;
dns.resolve4 = forbidNetworkAccess;
dns.resolve6 = forbidNetworkAccess;
dns.resolveAny = forbidNetworkAccess;
dns.resolveCaa = forbidNetworkAccess;
dns.resolveCname = forbidNetworkAccess;
dns.resolveMx = forbidNetworkAccess;
dns.resolveNaptr = forbidNetworkAccess;
dns.resolveNs = forbidNetworkAccess;
dns.resolvePtr = forbidNetworkAccess;
dns.resolveSoa = forbidNetworkAccess;
dns.resolveSrv = forbidNetworkAccess;
dns.resolveTxt = forbidNetworkAccess;
dns.reverse = forbidNetworkAccess;
dnsPromises.lookup = forbidNetworkAccess;
dnsPromises.lookupService = forbidNetworkAccess;
dnsPromises.resolve = forbidNetworkAccess;
dnsPromises.resolve4 = forbidNetworkAccess;
dnsPromises.resolve6 = forbidNetworkAccess;
dnsPromises.resolveAny = forbidNetworkAccess;
dnsPromises.resolveCaa = forbidNetworkAccess;
dnsPromises.resolveCname = forbidNetworkAccess;
dnsPromises.resolveMx = forbidNetworkAccess;
dnsPromises.resolveNaptr = forbidNetworkAccess;
dnsPromises.resolveNs = forbidNetworkAccess;
dnsPromises.resolvePtr = forbidNetworkAccess;
dnsPromises.resolveSoa = forbidNetworkAccess;
dnsPromises.resolveSrv = forbidNetworkAccess;
dnsPromises.resolveTxt = forbidNetworkAccess;
dnsPromises.reverse = forbidNetworkAccess;

syncBuiltinESMExports();
