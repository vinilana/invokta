import { pathToFileURL } from "node:url";

import { createHttpHandler, type HttpHandler } from "@invokta/http";
import { type HttpServerHandle, serveHttp } from "@invokta/http/node";

import { createDevelopmentBearerAuthenticator } from "./bearer-authentication.js";
import { engine } from "./engine.js";

export interface SupportHttpOptions {
  readonly expectedBearerToken: string;
  readonly host?: string;
  readonly port?: number;
}

/** The Web-standard handler, for Node, Deno, Bun, or a Workers runtime. */
export function createSupportHttpHandler(
  options: SupportHttpOptions,
): HttpHandler {
  return createHttpHandler(engine, {
    auth: {
      mode: "required",
      authenticate: createDevelopmentBearerAuthenticator(
        options.expectedBearerToken,
      ),
    },
  });
}

export async function startSupportHttp(
  options: SupportHttpOptions,
): Promise<HttpServerHandle> {
  return serveHttp(engine, {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    auth: {
      mode: "required",
      authenticate: createDevelopmentBearerAuthenticator(
        options.expectedBearerToken,
      ),
    },
  });
}

export async function main(): Promise<HttpServerHandle> {
  const expectedBearerToken = process.env.SUPPORT_ENGINE_BEARER_TOKEN;
  if (expectedBearerToken === undefined || expectedBearerToken === "") {
    throw new Error("SUPPORT_ENGINE_BEARER_TOKEN is required.");
  }
  const configuredPort = process.env.PORT;
  const port = configuredPort === undefined ? 3001 : Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return startSupportHttp({ expectedBearerToken, port });
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main()
    .then((server) => {
      const address = server.address();
      process.stderr.write(
        `Support engine HTTP adapter listening on host ${address.host}, port ${address.port}\n`,
      );
    })
    .catch(() => {
      process.stderr.write("Support engine HTTP adapter failed to start.\n");
      process.exitCode = 1;
    });
}
