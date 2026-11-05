import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { JSONWebKeySet } from "jose";

/**
 * A loopback JWKS endpoint. It stands in for an identity provider's key-set
 * URL so the remote key source, its cache, and its failure modes are exercised
 * over real HTTP without leaving the machine.
 */
export type JwksBehavior =
  | { readonly kind: "serve"; readonly jwks: JSONWebKeySet }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "malformed" }
  | { readonly kind: "reset" }
  | { readonly kind: "hang" };

export interface JwksServer {
  readonly url: URL;
  /** Number of key-set requests the endpoint received. */
  requests(): number;
  setBehavior(behavior: JwksBehavior): void;
  close(): Promise<void>;
}

export async function startJwksServer(
  initial: JwksBehavior,
): Promise<JwksServer> {
  let behavior = initial;
  let requests = 0;

  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      requests += 1;
      request.resume();
      switch (behavior.kind) {
        case "serve":
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(behavior.jwks));
          return;
        case "status":
          response.writeHead(behavior.status, {
            "content-type": "text/plain",
          });
          response.end("upstream detail that must never reach a client");
          return;
        case "malformed":
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{not json");
          return;
        case "reset":
          request.socket.destroy();
          return;
        case "hang":
          return;
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: new URL(`http://127.0.0.1:${port}/.well-known/jwks.json`),
    requests: () => requests,
    setBehavior(next) {
      behavior = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
