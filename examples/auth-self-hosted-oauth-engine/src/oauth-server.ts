/** Self-hosted OAuth 2.1 authorization server composition root. */
import "./env.js";

import { createServer, type IncomingMessage } from "node:http";

import { Pool } from "pg";

import {
  databasePoolConfig,
  requireDatabaseConfiguration,
} from "./database/config.js";
import { reportStartupFailure } from "./env.js";
import {
  formatOAuthRequestCompletion,
  formatOAuthRequestFailure,
  oauthDiagnosticRoute,
} from "./oauth/diagnostics.js";
import { createInteractionHandler } from "./oauth/interaction-server.js";
import {
  createOAuthProvider,
  formatOAuthRegistrationError,
} from "./oauth/oauth-provider.js";
import { readOAuthServerConfiguration } from "./oauth/server-config.js";

function requestHostname(request: IncomingMessage): string | null {
  const hostValues = request.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "host",
  );
  if (hostValues.length !== 1 || request.headers.host === undefined)
    return null;
  try {
    return new URL(`http://${request.headers.host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  requireDatabaseConfiguration();
  const configuration = readOAuthServerConfiguration();
  const pool = new Pool({
    ...databasePoolConfig(),
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  const composition = await createOAuthProvider(pool, configuration);
  composition.provider.on("registration_create.error", (context, error) => {
    process.stderr.write(
      formatOAuthRegistrationError(
        { method: context.method, path: context.path },
        error,
      ),
    );
  });
  const handleInteraction = createInteractionHandler(composition);
  const handleOidc = composition.provider.callback();
  const allowedHosts = new Set(configuration.allowedHosts);

  const server = createServer((request, response) => {
    let requestPath: string | undefined;
    void (async () => {
      const hostname = requestHostname(request);
      if (hostname === null || !allowedHosts.has(hostname)) {
        response.statusCode = 403;
        response.end("Forbidden.");
        return;
      }
      let path: string;
      try {
        path = new URL(request.url ?? "/", configuration.issuer).pathname;
      } catch {
        response.statusCode = 400;
        response.end("Invalid request target.");
        return;
      }
      requestPath = path;
      if (oauthDiagnosticRoute(path) !== null) {
        response.once("finish", () => {
          process.stderr.write(
            formatOAuthRequestCompletion({
              issuer: configuration.issuer,
              location: response.getHeader("location"),
              method: request.method,
              path,
              status: response.statusCode,
            }),
          );
        });
      }
      if (await handleInteraction(request, response, path)) return;
      handleOidc(request, response);
    })().catch((error: unknown) => {
      process.stderr.write(
        formatOAuthRequestFailure(
          { method: request.method, path: requestPath },
          error,
        ),
      );
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
      }
      if (!response.writableEnded) {
        response.end('{"error":"server_error"}');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(configuration.port, configuration.host, () => resolve());
  });

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => {
      pool.end().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.stderr.write(
    `OAuth issuer: ${configuration.issuer} (listening on ${configuration.host}:${configuration.port})\n`,
  );
}

main().catch(reportStartupFailure);
