import { createEngine, defineCapability } from "@invokta/core";
import { serveMcpHttp } from "@invokta/mcp";
import { z } from "zod";

import { startOnAvailablePort } from "../available-port.js";
import { verifyAccessToken } from "./oauth-provider.mjs";

/**
 * An Invokta engine served over MCP HTTP that accepts the access tokens issued
 * by `oauth-provider.mjs`, and nothing else.
 *
 * This is a test fixture, not a framework feature. Invokta implements zero
 * authentication and zero token verification (`docs/scope-and-limits.md`,
 * "Auth or PDP implementations | 0"); `auth.authenticate` is the single hook an
 * engine author fills in, and this is one filled-in example. It exists so an
 * OAuth authorization can be driven end to end against a real resource server.
 *
 * The provider and this engine both bind ephemeral ports, so neither origin is
 * known until it starts: the caller starts the provider first and passes its
 * origin and signing key here, which is what couples the two at runtime.
 */

const whoami = defineCapability({
  title: "Report the acting principal",
  description:
    "Reports the principal the MCP HTTP adapter derived from the token.",
  input: z.object({ marker: z.string() }),
  output: z.object({
    marker: z.string(),
    source: z.string(),
    principalId: z.string().nullable(),
  }),
  access: "public",
  async run({ input, context }) {
    return {
      marker: input.marker,
      source: context.source,
      principalId: context.principal === null ? null : context.principal.id,
    };
  },
});

const engine = createEngine({
  name: "oauth-fixture-engine",
  version: "1.0.0",
  capabilities: { "fixture.whoami": whoami },
});

/**
 * Starts the resource server. `authorizationServerUrl` is the provider origin
 * advertised to clients that hit a `401`, and `signingKey` is the provider's
 * key this engine verifies tokens with.
 */
export async function startOAuthEngine({ authorizationServerUrl, signingKey }) {
  const server = await startOnAvailablePort(async (port) => {
    const resource = `http://127.0.0.1:${String(port)}/mcp`;
    return serveMcpHttp(engine, {
      port,
      auth: {
        mode: "required",
        authenticate(request) {
          const header = request.headers.get("authorization");
          const bearer =
            header === null ? null : /^bearer (\S+)$/i.exec(header);
          if (bearer === null) return null;
          const payload = verifyAccessToken(bearer[1], {
            signingKey,
            audience: resource,
          });
          return payload === null ? null : { id: `oauth:${payload.sub}` };
        },
        resourceMetadata: {
          resource,
          authorizationServers: [authorizationServerUrl],
        },
      },
    });
  });
  const address = server.address();
  return {
    url: `http://${address.host}:${String(address.port)}/mcp`,
    close: () => server.close(),
  };
}
