import type { Principal } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { engine } from "../src/engine.js";
import { toPrincipal } from "../src/identity/principal.js";

const principal: Principal = toPrincipal({
  sub: "user_01JTESTUSER",
  sid: "session_01JTESTSESSION",
  org_id: "org_01JTESTORG",
  role: "admin",
  permissions: ["widgets:read"],
});

describe("auth-workos engine", () => {
  it("returns the verified identity to an authenticated caller", async () => {
    await expect(
      engine.invoke("identity.whoami", {}, { source: "mcp-http", principal }),
    ).resolves.toEqual({
      principalId: "user_01JTESTUSER",
      attributes: {
        sid: "session_01JTESTSESSION",
        org_id: "org_01JTESTORG",
        role: "admin",
        permissions: ["widgets:read"],
      },
    });
  });

  it("returns an empty attribute set for a principal without claims", async () => {
    await expect(
      engine.invoke(
        "identity.whoami",
        {},
        {
          source: "mcp-http",
          principal: toPrincipal({ sub: "user_01JPLAIN" }),
        },
      ),
    ).resolves.toEqual({ principalId: "user_01JPLAIN", attributes: {} });
  });

  it("rejects an unauthenticated caller before run", async () => {
    await expect(
      engine.invoke("identity.whoami", {}, { source: "mcp-http" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
