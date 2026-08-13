import type { McpClientToolResult, McpJsonValue } from "@invokta/mcp";

import { createAttachedSessionController } from "./attached-session.js";
import type { OAuthSession } from "./server.js";

/**
 * The interactive authorization of one external MCP endpoint for the
 * playground, chartered by ADR 0028. It reuses the attached-mode session
 * controller accepted by ADR 0022 and ADR 0023, so the Authorization Code with
 * PKCE flow and the in-memory lifetime of every token are exactly the ones
 * already accepted — including ADR 0030's amendment, which follows the
 * authorization servers the resource's own metadata advertises.
 *
 * OAuth is the one authentication type that cannot be per call: the
 * authorization is a session. Every other type connects and closes with the
 * invocation that used it.
 */

const owner = "playground";

export interface PlaygroundOAuth extends OAuthSession {
  /** Calls a tool over the authorized session. */
  call(
    toolName: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<McpClientToolResult>;
  close(): Promise<void>;
}

export function createPlaygroundOAuth(): PlaygroundOAuth {
  const controller = createAttachedSessionController();

  return {
    begin: async (url, options) => {
      const authorization = await controller.beginOAuth(
        owner,
        { transport: "http", url, authentication: { type: "oauth" } },
        options,
      );
      return { authorizationUrl: authorization.authorizationUrl };
    },
    complete: async (state, authorizationCode) => {
      await controller.completeOAuth(state, authorizationCode);
    },
    reject: async (state) => {
      await controller.rejectOAuth(state);
    },
    disconnect: async () => {
      await controller.disconnect(owner);
    },
    call: (toolName, input, signal) => {
      signal.throwIfAborted();
      return controller.call(
        owner,
        toolName,
        input as Readonly<Record<string, McpJsonValue>>,
      );
    },
    close: () => controller.close(),
  };
}
