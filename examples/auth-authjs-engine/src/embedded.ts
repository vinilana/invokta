import type { Principal } from "@invokta/core";

import { type AuthjsEngine, engine as defaultEngine } from "./engine.js";
import {
  type AuthjsSession,
  sessionToPrincipal,
} from "./identity/principal.js";

/**
 * The primary Auth.js surface: the host application already resolved its own
 * session with `auth()`, so the engine is invoked directly.
 *
 * In a Next.js App Router project this is a route handler:
 *
 * ```ts
 * // app/api/engine/whoami/route.ts
 * import { auth } from "@/auth";
 *
 * export const POST = createWhoamiRouteHandler({ resolveSession: auth });
 * ```
 *
 * No token crosses the boundary, because there is no boundary to cross.
 */

export interface WhoamiResult {
  readonly principalId: string;
  readonly attributes: Record<string, unknown>;
}

/** Matches the Auth.js `auth()` helper. */
export type AuthjsSessionResolver = () =>
  | Promise<AuthjsSession | null>
  | AuthjsSession
  | null;

export interface WhoamiInvocation {
  readonly principal: Principal;
  readonly signal: AbortSignal;
}

export type WhoamiRunner = (
  invocation: WhoamiInvocation,
) => Promise<WhoamiResult>;

export interface WhoamiRouteHandlerOptions {
  readonly resolveSession: AuthjsSessionResolver;
  readonly runWhoami?: WhoamiRunner;
}

/** Calls `engine.invoke` with the trusted principal and the request signal. */
export function createEngineWhoamiRunner(
  target: AuthjsEngine = defaultEngine,
): WhoamiRunner {
  return ({ principal, signal }) =>
    target.invoke(
      "identity.whoami",
      {},
      { source: "direct", principal, signal },
    );
}

const statusByErrorCode: Readonly<Record<string, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Maps an invocation failure to a status without exposing its details. */
function toErrorResponse(error: unknown): Response {
  const code =
    typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown }).code
      : undefined;
  const status =
    typeof code === "string" ? (statusByErrorCode[code] ?? 500) : 500;

  return jsonResponse(status, {
    error: { code: status === 500 ? "EXECUTION_FAILED" : code },
  });
}

export function createWhoamiRouteHandler(
  options: WhoamiRouteHandlerOptions,
): (request: Request) => Promise<Response> {
  const runWhoami = options.runWhoami ?? createEngineWhoamiRunner();

  return async (request) => {
    let principal: Principal | null;
    try {
      principal = sessionToPrincipal(await options.resolveSession());
    } catch {
      // Session resolution failed, which is infrastructure, not a denial.
      return jsonResponse(500, { error: { code: "EXECUTION_FAILED" } });
    }

    if (principal === null) {
      return jsonResponse(401, { error: { code: "UNAUTHENTICATED" } });
    }

    try {
      return jsonResponse(
        200,
        await runWhoami({ principal, signal: request.signal }),
      );
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
