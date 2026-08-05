import { describe, expect, it } from "vitest";

import {
  invokeWhoamiForSession,
  principalFromSession,
} from "../src/embedded.js";
import { engine } from "../src/engine.js";

const resolvedSession = {
  session: {
    id: "session_01",
    userId: "user_01",
    token: "opaque-better-auth-session-token",
    activeOrganizationId: "org_01",
  },
  user: {
    id: "user_01",
    email: "ada@example.com",
    emailVerified: true,
    name: "Ada Lovelace",
    image: "https://cdn.example.com/ada.png",
    role: "admin",
  },
} as const;

describe("the embedded Better Auth session surface", () => {
  it("maps a resolved session to a minimal principal", () => {
    const principal = principalFromSession(resolvedSession);

    expect(principal).toEqual({
      id: "user_01",
      attributes: {
        email: "ada@example.com",
        emailVerified: true,
        name: "Ada Lovelace",
        role: "admin",
        activeOrganizationId: "org_01",
      },
    });
  });

  it("keeps the session token out of the principal", () => {
    const principal = principalFromSession(resolvedSession);

    expect(JSON.stringify(principal)).not.toContain(
      resolvedSession.session.token,
    );
    expect(JSON.stringify(principal)).not.toContain("cdn.example.com");
  });

  it("treats an unresolved session as anonymous", () => {
    expect(principalFromSession(null)).toBeNull();
    expect(
      principalFromSession({
        session: { id: "session_01", userId: "" },
        user: { id: "" },
      }),
    ).toBeNull();
  });

  it("invokes identity.whoami with the host-resolved principal", async () => {
    await expect(invokeWhoamiForSession(resolvedSession)).resolves.toEqual({
      principalId: "user_01",
      attributes: {
        email: "ada@example.com",
        emailVerified: true,
        name: "Ada Lovelace",
        role: "admin",
        activeOrganizationId: "org_01",
      },
    });
  });

  it("refuses an anonymous embedded invocation", async () => {
    await expect(invokeWhoamiForSession(null)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(
      engine.invoke("identity.whoami", {}, { source: "direct" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
