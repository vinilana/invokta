import { pathToFileURL } from "node:url";

import type { Principal } from "@invokta/core";

import { engine } from "./engine.js";
import { type BetterAuthClaims, toPrincipal } from "./identity/principal.js";

/**
 * The shape `auth.api.getSession({ headers })` resolves to, narrowed to the
 * fields this engine authorizes on. The real result carries more — the opaque
 * session token, timestamps, the IP address, the user's image — and none of it
 * belongs in a principal.
 */
export interface BetterAuthResolvedSession {
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly activeOrganizationId?: string | null;
  };
  readonly user: {
    readonly id: string;
    readonly email?: string | null;
    readonly emailVerified?: boolean | null;
    readonly name?: string | null;
    readonly role?: string | null;
  };
}

function optionalString(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalBoolean(
  value: boolean | null | undefined,
): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Maps a session the host application already resolved to the same minimal
 * principal the HTTP hook produces. Returns `null` for an anonymous request,
 * which the `authenticated` access rule then reports as `UNAUTHENTICATED`.
 */
export function principalFromSession(
  resolved: BetterAuthResolvedSession | null,
): Principal | null {
  if (resolved === null) return null;

  const subject = optionalString(resolved.user.id);
  if (subject === undefined) return null;

  const email = optionalString(resolved.user.email);
  const emailVerified = optionalBoolean(resolved.user.emailVerified);
  const name = optionalString(resolved.user.name);
  const role = optionalString(resolved.user.role);
  const activeOrganizationId = optionalString(
    resolved.session.activeOrganizationId,
  );

  const claims: BetterAuthClaims = {
    subject,
    ...(email === undefined ? {} : { email }),
    ...(emailVerified === undefined ? {} : { emailVerified }),
    ...(name === undefined ? {} : { name }),
    ...(role === undefined ? {} : { role }),
    ...(activeOrganizationId === undefined ? {} : { activeOrganizationId }),
  };
  return toPrincipal(claims);
}

/**
 * The embedded surface: the host application owns the session, so no token
 * crosses a process boundary and no second verification happens. This is the
 * call a Better Auth route handler makes after `auth.api.getSession`.
 */
export async function invokeWhoamiForSession(
  resolved: BetterAuthResolvedSession | null,
) {
  return engine.invoke(
    "identity.whoami",
    {},
    { source: "direct", principal: principalFromSession(resolved) },
  );
}

export async function main(): Promise<void> {
  const result = await invokeWhoamiForSession({
    session: { id: "session_demo", userId: "user_demo" },
    user: {
      id: "user_demo",
      email: "demo@example.com",
      emailVerified: true,
      name: "Demo User",
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main().catch(() => {
    process.stderr.write("Better Auth engine embedded invocation failed.\n");
    process.exitCode = 1;
  });
}
