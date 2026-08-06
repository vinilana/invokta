import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTACHED_SESSION_LIMITS,
  AttachedSessionError,
  createAttachedSessionController,
  retainValidationFailure,
} from "../src/attached-session.js";

const owner = "browser-session-a";
const otherOwner = "browser-session-b";
const target = {
  transport: "http",
  url: "https://mcp.example.test/mcp",
  authentication: { type: "bearer", token: "target-canary-secret" },
} as const;
const oauthTarget = {
  transport: "http",
  url: "https://mcp.example.test/mcp",
  authentication: { type: "oauth" },
} as const;
const oauthState = "abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF";

const server = {
  name: "fixture-server",
  version: "1.0.0",
  protocolVersion: "2025-11-25",
  capabilities: {},
} as const;

interface FixtureTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

function tool(name: string, description?: string): FixtureTool {
  return description === undefined
    ? { name, inputSchema: { type: "object" } }
    : { name, description, inputSchema: { type: "object" } };
}

function connection(
  listTools: (
    cursor?: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<{
    readonly tools: readonly ReturnType<typeof tool>[];
    readonly nextCursor?: string;
  }>,
  callTool: (
    name: string,
    argumentsValue?: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<{
    readonly response: Readonly<Record<string, unknown>>;
  }> = async () => ({ response: { content: [] } }),
) {
  return {
    server,
    listTools: vi.fn(listTools),
    callTool: vi.fn(callTool),
    close: vi.fn(async () => undefined),
  };
}

function controllerWith(connectClient: (...args: never[]) => unknown) {
  return createAttachedSessionController({
    connectClient: connectClient as never,
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<AttachedSessionError> {
  const rejection = await promise.catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(AttachedSessionError);
  expect(rejection).toMatchObject({ code });
  return rejection as AttachedSessionError;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createAttachedSessionController", () => {
  it("retains only a cause-free validation failure snapshot", () => {
    const sensitiveCause = new Error("sensitive upstream detail");
    const failure = new AttachedSessionError("CONNECTION_FAILED", {
      cause: sensitiveCause,
    });

    const retained = retainValidationFailure(owner, failure);

    expect(retained).toEqual({
      owner,
      code: "CONNECTION_FAILED",
      message: "The MCP connection failed.",
    });
    expect(retained).not.toBe(failure);
    expect(Object.hasOwn(retained, "cause")).toBe(false);
    expect(JSON.stringify(retained)).not.toContain("sensitive upstream detail");
  });

  it("owns an OAuth authorization and completes it into the normal catalog", async () => {
    const client = connection(async () => ({ tools: [tool("fixture.oauth")] }));
    const authorization = {
      authorizationUrl:
        "https://identity.example.test/authorize?state=opaque-state",
      finish: vi.fn(async () => client),
      close: vi.fn(async () => undefined),
    };
    const beginOAuthAuthorization = vi.fn(async () => authorization);
    const controller = createAttachedSessionController({
      beginOAuthAuthorization: beginOAuthAuthorization as never,
    });

    await expect(
      controller.beginOAuth(owner, oauthTarget, {
        redirectUrl: "http://127.0.0.1:4100/oauth/callback",
        state: oauthState,
      }),
    ).resolves.toEqual({ authorizationUrl: authorization.authorizationUrl });
    expect(controller.state(owner)).toEqual({
      state: "authorizing",
      transport: "http",
    });
    expect(controller.state(otherOwner)).toEqual({ state: "busy" });

    await expect(
      controller.completeOAuth(oauthState, "one-time-code"),
    ).resolves.toMatchObject({
      transport: "http",
      pageCount: 1,
      toolCount: 1,
    });
    expect(authorization.finish).toHaveBeenCalledWith(
      "one-time-code",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(controller.state(owner).state).toBe("connected");
    expect(controller.tools(owner).map(({ name }) => name)).toEqual([
      "fixture.oauth",
    ]);

    await expectCode(
      controller.completeOAuth(oauthState, "replayed-code"),
      "NOT_CONNECTED",
    );
  });

  it("rejects the wrong OAuth state and cancels authorization without exposing it", async () => {
    const authorization = {
      authorizationUrl:
        "https://identity.example.test/authorize?state=opaque-state",
      finish: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const controller = createAttachedSessionController({
      beginOAuthAuthorization: vi.fn(async () => authorization) as never,
    });
    await controller.beginOAuth(owner, oauthTarget, {
      redirectUrl: "http://127.0.0.1:4100/oauth/callback",
      state: oauthState,
    });

    await expectCode(
      controller.completeOAuth(`${oauthState.slice(0, -1)}X`, "code"),
      "AUTHENTICATION_FAILED",
    );
    expect(authorization.finish).not.toHaveBeenCalled();
    expect(controller.state(owner).state).toBe("authorizing");

    await expectCode(
      controller.rejectOAuth(`${oauthState.slice(0, -1)}X`),
      "AUTHENTICATION_FAILED",
    );
    expect(controller.state(owner).state).toBe("authorizing");

    await controller.rejectOAuth(oauthState);
    expect(authorization.close).toHaveBeenCalledOnce();
    expect(controller.state(owner)).toMatchObject({
      state: "idle",
      validation: {
        status: "error",
        error: { code: "AUTHENTICATION_FAILED" },
      },
    });
    expect(JSON.stringify(controller.state(owner))).not.toContain(oauthState);
  });

  it("expires an unfinished OAuth authorization at exactly five minutes", async () => {
    vi.useFakeTimers();
    const authorization = {
      authorizationUrl:
        "https://identity.example.test/authorize?state=opaque-state",
      finish: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const controller = createAttachedSessionController({
      beginOAuthAuthorization: vi.fn(async () => authorization) as never,
    });
    await controller.beginOAuth(owner, oauthTarget, {
      redirectUrl: "http://127.0.0.1:4100/oauth/callback",
      state: oauthState,
    });

    await vi.advanceTimersByTimeAsync(
      ATTACHED_SESSION_LIMITS.oauthAuthorizationTimeoutMs - 1,
    );
    expect(controller.state(owner).state).toBe("authorizing");
    await vi.advanceTimersByTimeAsync(1);

    expect(authorization.close).toHaveBeenCalledOnce();
    expect(controller.state(owner)).toMatchObject({
      state: "idle",
      validation: { status: "error", error: { code: "TIMEOUT" } },
    });
  });

  it("bounds OAuth preparation and closes a late authorization handle", async () => {
    vi.useFakeTimers();
    const pending = deferred<{
      authorizationUrl: string;
      finish: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }>();
    const controller = createAttachedSessionController({
      beginOAuthAuthorization: vi.fn(() => pending.promise) as never,
    });
    const beginning = controller.beginOAuth(owner, oauthTarget, {
      redirectUrl: "http://127.0.0.1:4100/oauth/callback",
      state: oauthState,
    });
    const timedOut = expect(beginning).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(
      ATTACHED_SESSION_LIMITS.initializationTimeoutMs - 1,
    );
    expect(controller.state(owner).state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;

    const lateAuthorization = {
      authorizationUrl:
        "https://identity.example.test/authorize?state=opaque-state",
      finish: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    pending.resolve(lateAuthorization);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateAuthorization.close).toHaveBeenCalledOnce();
    expect(controller.state(owner)).toMatchObject({
      state: "idle",
      validation: { status: "error", error: { code: "TIMEOUT" } },
    });
  });

  it("bounds OAuth token exchange and closes a late connection", async () => {
    vi.useFakeTimers();
    const pendingConnection = deferred<ReturnType<typeof connection>>();
    const authorization = {
      authorizationUrl:
        "https://identity.example.test/authorize?state=opaque-state",
      finish: vi.fn(() => pendingConnection.promise),
      close: vi.fn(async () => undefined),
    };
    const controller = createAttachedSessionController({
      beginOAuthAuthorization: vi.fn(async () => authorization) as never,
    });
    await controller.beginOAuth(owner, oauthTarget, {
      redirectUrl: "http://127.0.0.1:4100/oauth/callback",
      state: oauthState,
    });
    const completion = controller.completeOAuth(oauthState, "one-time-code");
    const timedOut = expect(completion).rejects.toMatchObject({
      code: "TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(
      ATTACHED_SESSION_LIMITS.initializationTimeoutMs - 1,
    );
    expect(controller.state(owner).state).toBe("authorizing");
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    expect(authorization.close).toHaveBeenCalledOnce();

    const lateConnection = connection(async () => ({ tools: [] }));
    pendingConnection.resolve(lateConnection);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateConnection.close).toHaveBeenCalledOnce();
    expect(controller.state(owner)).toMatchObject({
      state: "idle",
      validation: { status: "error", error: { code: "TIMEOUT" } },
    });
  });

  it("atomically owns one target and exposes only busy state to another owner", async () => {
    const pending = deferred<ReturnType<typeof connection>>();
    const connectClient = vi.fn(() => pending.promise);
    const controller = controllerWith(connectClient);

    const connecting = controller.connect(owner, target);

    expect(controller.state(owner)).toEqual({
      state: "connecting",
      transport: "http",
    });
    expect(controller.state(otherOwner)).toEqual({ state: "busy" });
    await expectCode(controller.connect(otherOwner, target), "TARGET_BUSY");

    const client = connection(async () => ({ tools: [tool("fixture.echo")] }));
    pending.resolve(client);
    await connecting;

    expect(controller.state(owner)).toMatchObject({
      state: "connected",
      connection: {
        transport: "http",
        pageCount: 1,
        toolCount: 1,
        server: {
          name: server.name,
          version: server.version,
          protocolVersion: server.protocolVersion,
        },
      },
    });
    expect(controller.tools(owner).map((entry) => entry.name)).toEqual([
      "fixture.echo",
    ]);
    await expectCode(
      Promise.resolve().then(() => controller.tools(otherOwner)),
      "TARGET_BUSY",
    );

    await controller.disconnect(owner);
    expect(client.close).toHaveBeenCalledOnce();
    expect(controller.state(owner)).toMatchObject({ state: "idle" });
    const retained = controller.activity(owner);
    expect(retained.map((record) => record.operation)).toEqual([
      "initialize",
      "tools/list",
      "disconnect",
    ]);
    expect(controller.state(owner)).toMatchObject({
      state: "idle",
      activity: retained,
    });
  });

  it("walks every page sequentially, including an empty cursor, in server order", async () => {
    const client = connection(async (cursor) => {
      if (cursor === undefined) {
        return { tools: [tool("first")], nextCursor: "" };
      }
      if (cursor === "") {
        return { tools: [tool("second")], nextCursor: "last" };
      }
      return { tools: [tool("third")] };
    });
    const controller = controllerWith(vi.fn(async () => client));

    const connected = await controller.connect(owner, target);

    expect(connected).toMatchObject({ pageCount: 3, toolCount: 3 });
    expect(controller.tools(owner).map((entry) => entry.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(client.listTools.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      "",
      "last",
    ]);
    expect(
      client.listTools.mock.calls.every(
        ([, options]) => options?.signal instanceof AbortSignal,
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "a repeated cursor",
      pages: async (cursor?: string) =>
        cursor === undefined
          ? { tools: [tool("first")], nextCursor: "again" }
          : { tools: [tool("second")], nextCursor: "again" },
      code: "PROTOCOL_ERROR",
    },
    {
      name: "a duplicate tool name",
      pages: async (cursor?: string) =>
        cursor === undefined
          ? { tools: [tool("same")], nextCursor: "next" }
          : { tools: [tool("same")] },
      code: "PROTOCOL_ERROR",
    },
    {
      name: "a non-lossless catalog value",
      pages: async () => ({
        tools: [
          {
            name: "invalid",
            inputSchema: { minimum: Number.NaN },
          },
        ],
      }),
      code: "PROTOCOL_ERROR",
    },
  ])("fails closed for $name", async ({ pages, code }) => {
    const client = connection(pages);
    const controller = controllerWith(vi.fn(async () => client));

    await expectCode(controller.connect(owner, target), code);

    expect(client.close).toHaveBeenCalledOnce();
    expect(controller.state(owner)).toMatchObject({
      state: "idle",
      validation: { status: "error", error: { code } },
    });
  });

  it("accepts exactly 100 catalog pages and rejects a cursor for page 101", async () => {
    const acceptedClient = connection(async (cursor) => {
      const page = cursor === undefined ? 1 : Number(cursor);
      return page === ATTACHED_SESSION_LIMITS.catalogPages
        ? { tools: [tool(`tool-${page}`)] }
        : { tools: [tool(`tool-${page}`)], nextCursor: String(page + 1) };
    });
    const accepted = controllerWith(vi.fn(async () => acceptedClient));

    await expect(accepted.connect(owner, target)).resolves.toMatchObject({
      pageCount: 100,
      toolCount: 100,
    });

    const rejectedClient = connection(async (cursor) => {
      const page = cursor === undefined ? 1 : Number(cursor);
      return {
        tools: [tool(`tool-${page}`)],
        nextCursor: String(page + 1),
      };
    });
    const rejected = controllerWith(vi.fn(async () => rejectedClient));

    await expectCode(rejected.connect(owner, target), "LIMIT_EXCEEDED");
    expect(rejectedClient.listTools).toHaveBeenCalledTimes(100);
    expect(rejectedClient.close).toHaveBeenCalledOnce();
  });

  it("accepts 2,000 tools and rejects the first tool beyond the bound", async () => {
    const exactTools = Array.from(
      { length: ATTACHED_SESSION_LIMITS.catalogTools },
      (_, index) => tool(`tool-${index}`),
    );
    const acceptedClient = connection(async () => ({ tools: exactTools }));
    const accepted = controllerWith(vi.fn(async () => acceptedClient));

    await expect(accepted.connect(owner, target)).resolves.toMatchObject({
      toolCount: 2_000,
    });

    const rejectedClient = connection(async () => ({
      tools: [...exactTools, tool("one-too-many")],
    }));
    const rejected = controllerWith(vi.fn(async () => rejectedClient));

    await expectCode(rejected.connect(owner, target), "LIMIT_EXCEEDED");
    expect(rejectedClient.close).toHaveBeenCalledOnce();
  });

  it("accepts an exactly 10 MiB compact catalog and rejects the next byte", async () => {
    const emptyDescription = tool("large", "");
    const emptySize = Buffer.byteLength(JSON.stringify([emptyDescription]));
    const exactDescription = "x".repeat(
      ATTACHED_SESSION_LIMITS.catalogBytes - emptySize,
    );
    const exactTool = tool("large", exactDescription);
    expect(Buffer.byteLength(JSON.stringify([exactTool]))).toBe(
      ATTACHED_SESSION_LIMITS.catalogBytes,
    );

    const acceptedClient = connection(async () => ({ tools: [exactTool] }));
    const accepted = controllerWith(vi.fn(async () => acceptedClient));
    await expect(accepted.connect(owner, target)).resolves.toMatchObject({
      toolCount: 1,
    });

    const rejectedClient = connection(async () => ({
      tools: [tool("large", `${exactDescription}x`)],
    }));
    const rejected = controllerWith(vi.fn(async () => rejectedClient));
    await expectCode(rejected.connect(owner, target), "LIMIT_EXCEEDED");
    expect(rejectedClient.close).toHaveBeenCalledOnce();
  });

  it("times out unresolved initialization at exactly 15 seconds", async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof connection>>();
    const controller = controllerWith(vi.fn(() => pending.promise));

    const connecting = controller.connect(owner, target);
    void connecting.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(
      ATTACHED_SESSION_LIMITS.initializationTimeoutMs - 1,
    );
    expect(controller.state(owner).state).toBe("connecting");

    await vi.advanceTimersByTimeAsync(1);
    await expectCode(connecting, "TIMEOUT");
    expect(controller.state(owner).state).toBe("idle");

    const lateClient = connection(async () => ({ tools: [] }));
    pending.resolve(lateClient);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(lateClient.close).toHaveBeenCalledOnce();
  });

  it("gives catalog collection a separate 15-second deadline", async () => {
    vi.useFakeTimers();
    const never = deferred<{
      readonly tools: readonly ReturnType<typeof tool>[];
    }>();
    const client = connection(() => never.promise);
    const controller = controllerWith(vi.fn(async () => client));

    const connecting = controller.connect(owner, target);
    void connecting.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ATTACHED_SESSION_LIMITS.catalogTimeoutMs);

    await expectCode(connecting, "TIMEOUT");
    expect(client.close).toHaveBeenCalledOnce();
    expect(controller.state(owner).state).toBe("idle");
  });

  it("allows one explicit call, snapshots arguments, and retains metadata only", async () => {
    const observedArguments: unknown[] = [];
    const client = connection(
      async () => ({ tools: [tool("fixture.echo")] }),
      async (_name, argumentsValue) => {
        observedArguments.push(argumentsValue);
        return {
          response: {
            content: [{ type: "text", text: "sensitive-result" }],
          },
        };
      },
    );
    const controller = controllerWith(vi.fn(async () => client));
    await controller.connect(owner, target);
    const argumentsValue = { message: "before" };

    const result = controller.call(owner, "fixture.echo", argumentsValue);
    argumentsValue.message = "after";

    await expect(result).resolves.toEqual({
      response: {
        content: [{ type: "text", text: "sensitive-result" }],
      },
    });
    expect(observedArguments).toEqual([{ message: "before" }]);
    const serializedActivity = JSON.stringify(controller.activity(owner));
    expect(serializedActivity).toContain("fixture.echo");
    expect(serializedActivity).not.toContain("before");
    expect(serializedActivity).not.toContain("sensitive-result");
    expect(serializedActivity).not.toContain("target-canary-secret");
  });

  it("rejects a concurrent call and disconnect cancels the active call", async () => {
    const callStarted = deferred<void>();
    const client = connection(
      async () => ({ tools: [tool("fixture.wait")] }),
      async (_name, _argumentsValue, options) => {
        callStarted.resolve();
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("internal cancellation details")),
            { once: true },
          );
        });
      },
    );
    const controller = controllerWith(vi.fn(async () => client));
    await controller.connect(owner, target);

    const firstCall = controller.call(owner, "fixture.wait", {});
    await callStarted.promise;
    await expectCode(controller.call(owner, "fixture.wait", {}), "TARGET_BUSY");

    await controller.disconnect(owner);
    await expectCode(firstCall, "CANCELLED");
    expect(client.callTool).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(
      controller.activity(owner).map((record) => record.operation),
    ).toEqual(["initialize", "tools/list", "tools/call", "disconnect"]);
  });

  it("times out a manual call at exactly 60 seconds and releases the target", async () => {
    vi.useFakeTimers();
    const never = deferred<{
      readonly response: Readonly<Record<string, unknown>>;
    }>();
    const client = connection(
      async () => ({ tools: [tool("fixture.wait")] }),
      () => never.promise,
    );
    const controller = controllerWith(vi.fn(async () => client));
    await controller.connect(owner, target);

    const calling = controller.call(owner, "fixture.wait", {});
    void calling.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(
      ATTACHED_SESSION_LIMITS.callTimeoutMs - 1,
    );
    expect(controller.state(owner).state).toBe("connected");

    await vi.advanceTimersByTimeAsync(1);
    await expectCode(calling, "TIMEOUT");
    expect(client.close).toHaveBeenCalledOnce();
    expect(controller.state(owner).state).toBe("idle");
  });

  it("keeps only the newest 500 metadata records", async () => {
    const client = connection(async () => ({ tools: [tool("fixture.echo")] }));
    const controller = controllerWith(vi.fn(async () => client));
    await controller.connect(owner, target);

    for (let index = 0; index < 501; index += 1) {
      await controller.call(owner, "fixture.echo", { index });
    }

    const activity = controller.activity(owner);
    expect(activity).toHaveLength(ATTACHED_SESSION_LIMITS.activityRecords);
    expect(activity[0]?.sequence).toBe(4);
    expect(activity.at(-1)?.sequence).toBe(503);
    expect(activity.every((record) => record.operation === "tools/call")).toBe(
      true,
    );
  });

  it("retains only the newest 50 records in the idle state", async () => {
    const client = connection(async () => ({ tools: [tool("fixture.echo")] }));
    const controller = controllerWith(vi.fn(async () => client));
    await controller.connect(owner, target);
    for (let index = 0; index < 60; index += 1) {
      await controller.call(owner, "fixture.echo", { index });
    }

    await controller.disconnect(owner);

    // Sequences: 1 initialize, 2 tools/list, 3-62 calls, 63 disconnect.
    const retained = controller.activity(owner);
    expect(retained).toHaveLength(
      ATTACHED_SESSION_LIMITS.retainedActivityRecords,
    );
    expect(retained[0]?.sequence).toBe(14);
    expect(retained.at(-1)?.operation).toBe("disconnect");
    const idle = controller.state(owner);
    expect(idle.state).toBe("idle");
    if (idle.state !== "idle") return;
    expect(idle.activity).toEqual(retained);
  });

  it("drops the retained records when a new target connects", async () => {
    const client = connection(async () => ({ tools: [tool("fixture.echo")] }));
    const controller = controllerWith(vi.fn(async () => client));
    await controller.connect(owner, target);
    await controller.disconnect(owner);
    expect(controller.activity(owner).length).toBeGreaterThan(0);

    await controller.connect(owner, target);

    expect(controller.state(owner).state).toBe("connected");
    expect(
      controller.activity(owner).map((record) => record.operation),
    ).toEqual(["initialize", "tools/list"]);
  });

  it("retains the records that preceded a connection failure", async () => {
    const client = connection(async () => {
      throw new Error("catalog blew up");
    });
    const controller = controllerWith(vi.fn(async () => client));

    await expectCode(controller.connect(owner, target), "PROTOCOL_ERROR");

    const idle = controller.state(owner);
    expect(idle.state).toBe("idle");
    if (idle.state !== "idle") return;
    expect(idle.validation?.error.code).toBe("PROTOCOL_ERROR");
    expect(
      idle.activity?.map((record) => [record.operation, record.outcome]),
    ).toEqual([
      ["initialize", "success"],
      ["tools/list", "error"],
    ]);
    expect(controller.activity(owner)).toEqual(idle.activity);
  });

  it("bounds server-provided tool names before adding them to Activity", async () => {
    const longName = `tool-${"x".repeat(4_000)}`;
    const client = connection(async () => ({ tools: [tool(longName)] }));
    const controller = controllerWith(vi.fn(async () => client));
    await controller.connect(owner, target);

    await controller.call(owner, longName, {});

    const callRecord = controller
      .activity(owner)
      .find((record) => record.operation === "tools/call");
    expect(callRecord?.toolName?.length).toBeLessThan(longName.length);
    expect(callRecord?.toolName?.startsWith("tool-")).toBe(true);
  });

  it("sanitizes unknown failures and serializes only stable public data", async () => {
    const secret = "connector-secret-and-url";
    const controller = controllerWith(
      vi.fn(async () => {
        throw new Error(secret);
      }),
    );

    const rejection = await expectCode(
      controller.connect(owner, target),
      "CONNECTION_FAILED",
    );

    expect(Object.keys(rejection).sort()).toEqual(["code", "message"]);
    expect(JSON.stringify(rejection)).not.toContain(secret);
    expect(JSON.stringify(controller.state(owner))).not.toContain(secret);
    expect(JSON.stringify(controller.state(owner))).not.toContain(
      "target-canary-secret",
    );
  });

  it("closes the process-owned target once during controller shutdown", async () => {
    const client = connection(async () => ({ tools: [] }));
    const controller = controllerWith(vi.fn(async () => client));
    await controller.connect(owner, target);

    await Promise.all([controller.close(), controller.close()]);

    expect(client.close).toHaveBeenCalledOnce();
    expect(controller.state(owner)).toEqual({ state: "idle" });
  });
});
