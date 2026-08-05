import { describe, expect, it, vi } from "vitest";

import {
  createEngineWhoamiRunner,
  createWhoamiRouteHandler,
  type WhoamiRunner,
} from "../src/embedded.js";
import { createAuthjsEngine } from "../src/engine.js";
import type { AuthjsSession } from "../src/identity/principal.js";
import { createTestSession } from "./support/tokens.js";

function request(): Request {
  return new Request("http://127.0.0.1/api/engine/whoami", { method: "POST" });
}

const resolves =
  (session: AuthjsSession | null) => async (): Promise<AuthjsSession | null> =>
    session;

describe("embedded Auth.js route handler", () => {
  it("invokes the capability with the principal derived from the session", async () => {
    const handler = createWhoamiRouteHandler({
      resolveSession: resolves(createTestSession()),
      runWhoami: createEngineWhoamiRunner(createAuthjsEngine()),
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      principalId: "user_2f1a",
      attributes: {
        channel: "authjs-session",
        email: "ada@example.test",
        name: "Ada Lovelace",
      },
    });
  });

  it("passes the request abort signal into the invocation", async () => {
    const runWhoami = vi.fn<WhoamiRunner>(async () => ({
      principalId: "user_2f1a",
      attributes: {},
    }));
    const handler = createWhoamiRouteHandler({
      resolveSession: resolves(createTestSession()),
      runWhoami,
    });

    await handler(request());

    expect(runWhoami).toHaveBeenCalledOnce();
    expect(runWhoami.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(runWhoami.mock.calls[0]?.[0].principal).toEqual({
      id: "user_2f1a",
      attributes: {
        channel: "authjs-session",
        email: "ada@example.test",
        name: "Ada Lovelace",
      },
    });
  });

  it("answers 401 and never invokes the engine without a usable session", async () => {
    const runWhoami = vi.fn<WhoamiRunner>();

    for (const session of [
      null,
      createTestSession({ user: undefined }),
      createTestSession({ user: { name: "Ada" } }),
      createTestSession({ expires: new Date(Date.now() - 1000).toISOString() }),
    ] satisfies ReadonlyArray<AuthjsSession | null>) {
      const handler = createWhoamiRouteHandler({
        resolveSession: resolves(session),
        runWhoami,
      });

      const response = await handler(request());

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: { code: "UNAUTHENTICATED" },
      });
    }

    expect(runWhoami).not.toHaveBeenCalled();
  });

  it("answers a sanitized 500 when session resolution itself fails", async () => {
    const runWhoami = vi.fn<WhoamiRunner>();
    const handler = createWhoamiRouteHandler({
      resolveSession: () => {
        throw new Error("AUTH_SECRET is missing");
      },
      runWhoami,
    });

    const response = await handler(request());

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("AUTH_SECRET");
    expect(runWhoami).not.toHaveBeenCalled();
  });

  it("maps a capability denial to 403 without leaking details", async () => {
    const handler = createWhoamiRouteHandler({
      resolveSession: resolves(createTestSession()),
      runWhoami: async () => {
        throw Object.assign(new Error("policy document 42 denied"), {
          code: "FORBIDDEN",
        });
      },
    });

    const response = await handler(request());

    expect(response.status).toBe(403);
    expect(await response.text()).toBe(
      JSON.stringify({ error: { code: "FORBIDDEN" } }),
    );
  });
});

describe("embedded engine invocation", () => {
  it("denies an anonymous invocation of the capability", async () => {
    const engine = createAuthjsEngine();

    await expect(engine.invoke("identity.whoami", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("derives the result from the trusted principal, not from input", async () => {
    const engine = createAuthjsEngine();

    await expect(
      engine.invoke("identity.whoami", { principalId: "attacker" } as never, {
        principal: { id: "user_2f1a", attributes: { channel: "test" } },
      }),
    ).resolves.toEqual({
      principalId: "user_2f1a",
      attributes: { channel: "test" },
    });
  });
});
