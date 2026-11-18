import {
  createEngine,
  defineCapability,
  type EngineEvent,
  type Principal,
} from "@invokta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createHttpHandler,
  type HttpCapabilityVisibility,
} from "../src/index.js";
import { serveHttp } from "../src/node.js";

function createVisibilityEngine(events: EngineEvent[] = []) {
  const capability = (description: string) =>
    defineCapability({
      description,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "authenticated",
      async run() {
        return { ok: true };
      },
    });
  return createEngine({
    name: "visibility-engine",
    version: "0.1.0",
    onEvent: (event) => {
      events.push(event);
    },
    capabilities: {
      "billing.get-invoice": capability("Read one invoice."),
      "billing.refund": capability("Refund one invoice."),
    },
  });
}

const principals: Record<string, Principal> = {
  reader: { id: "reader" },
  admin: { id: "admin", attributes: { admin: true } },
};

const visibility: HttpCapabilityVisibility = ({ principal, capabilityId }) =>
  principal?.attributes?.admin === true ||
  capabilityId === "billing.get-invoice";

function handlerFor(
  options: { visibility?: unknown; events?: EngineEvent[] } = {},
) {
  return createHttpHandler(createVisibilityEngine(options.events), {
    ...(options.visibility === undefined
      ? {}
      : { visibility: options.visibility as HttpCapabilityVisibility }),
    auth: {
      mode: "required",
      authenticate: ({ headers }) =>
        principals[headers.get("x-user") ?? ""] ?? null,
    },
  });
}

function get(user: string, path: string): Request {
  return new Request(`http://127.0.0.1${path}`, {
    headers: { "x-user": user },
  });
}

function post(user: string, id: string): Request {
  return new Request(`http://127.0.0.1/capabilities/${id}`, {
    method: "POST",
    headers: { "x-user": user, "content-type": "application/json" },
    body: "{}",
  });
}

describe("HTTP capability visibility", () => {
  it("lists only the capabilities visible to the principal", async () => {
    const handler = handlerFor({ visibility });
    const ids = async (user: string) =>
      (
        (await (await handler(get(user, "/capabilities"))).json()) as {
          capabilities: { id: string }[];
        }
      ).capabilities.map((capability) => capability.id);

    expect(await ids("reader")).toEqual(["billing.get-invoice"]);
    expect(await ids("admin")).toEqual([
      "billing.get-invoice",
      "billing.refund",
    ]);
  });

  it("answers a hidden capability exactly like a nonexistent one, without invoking", async () => {
    const events: EngineEvent[] = [];
    const handler = handlerFor({ visibility, events });

    const hiddenDescribe = await handler(
      get("reader", "/capabilities/billing.refund"),
    );
    const hiddenInvoke = await handler(post("reader", "billing.refund"));
    const missingInvoke = await handler(post("reader", "billing.missing"));

    expect(hiddenDescribe.status).toBe(404);
    expect(hiddenInvoke.status).toBe(404);
    expect(await hiddenInvoke.json()).toEqual({
      error: {
        code: "CAPABILITY_NOT_FOUND",
        message: "Capability not found.",
        publicDetails: { capabilityId: "billing.refund" },
      },
    });
    expect(missingInvoke.status).toBe(404);
    expect(events).toEqual([]);

    const allowed = await handler(post("admin", "billing.refund"));
    expect(await allowed.json()).toEqual({ ok: true });
  });

  it("generates the OpenAPI document from the visible capabilities", async () => {
    const handler = handlerFor({ visibility });
    const paths = async (user: string) =>
      Object.keys(
        (
          (await (await handler(get(user, "/openapi.json"))).json()) as {
            paths: Record<string, unknown>;
          }
        ).paths,
      );

    expect(await paths("reader")).toEqual([
      "/capabilities",
      "/capabilities/billing.get-invoice",
    ]);
    expect(await paths("admin")).toContain("/capabilities/billing.refund");
    expect(await paths("reader")).not.toContain("/capabilities/billing.refund");
  });

  it("hides a capability whose predicate throws", async () => {
    const handler = handlerFor({
      visibility: (({ capabilityId }) => {
        if (capabilityId === "billing.refund") throw new Error("broken");
        return true;
      }) satisfies HttpCapabilityVisibility,
    });

    expect((await handler(post("admin", "billing.refund"))).status).toBe(404);
  });

  it("forwards the visibility option from the Node.js server", async () => {
    const server = await serveHttp(createVisibilityEngine(), {
      port: 0,
      visibility,
      auth: {
        mode: "required",
        authenticate: ({ headers }) =>
          principals[headers.get("x-user") ?? ""] ?? null,
      },
    });
    try {
      const { port } = server.address();
      const response = await fetch(
        `http://127.0.0.1:${String(port)}/capabilities`,
        { headers: { "x-user": "reader" } },
      );
      const body = (await response.json()) as {
        capabilities: { id: string }[];
      };
      expect(body.capabilities.map((capability) => capability.id)).toEqual([
        "billing.get-invoice",
      ]);
    } finally {
      await server.close();
    }
  });

  it("never serves one principal's OpenAPI document to another", async () => {
    const capability = defineCapability({
      description: "One capability.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "public",
      async run() {
        return { ok: true };
      },
    });
    // "a\nb" would collide with ["a", "b"] under a newline-joined key.
    const handler = createHttpHandler(
      createEngine({
        name: "collision-engine",
        version: "0.1.0",
        capabilities: { a: capability, b: capability, "a\nb": capability },
      }),
      {
        visibility: ({ principal, capabilityId }) =>
          principal?.id === "one"
            ? capabilityId === "a\nb"
            : capabilityId !== "a\nb",
        auth: {
          mode: "required",
          authenticate: ({ headers }) => ({ id: headers.get("x-user") ?? "" }),
        },
      },
    );
    const paths = async (user: string) =>
      Object.keys(
        (
          (await (await handler(get(user, "/openapi.json"))).json()) as {
            paths: Record<string, unknown>;
          }
        ).paths,
      );

    expect(await paths("one")).toEqual([
      "/capabilities",
      "/capabilities/a%0Ab",
    ]);
    expect(await paths("two")).toEqual([
      "/capabilities",
      "/capabilities/a",
      "/capabilities/b",
    ]);
  });

  it("caches at most 64 OpenAPI documents and evicts the first inserted", async () => {
    const capability = defineCapability({
      description: "One capability.",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      access: "public",
      async run() {
        return { ok: true };
      },
    });
    // Seven capabilities give 127 distinct non-empty visible sets.
    const ids = ["c0", "c1", "c2", "c3", "c4", "c5", "c6"] as const;
    const engine = createEngine({
      name: "cache-engine",
      version: "0.1.0",
      capabilities: Object.fromEntries(ids.map((id) => [id, capability])),
    });
    let describes = 0;
    const counted = {
      name: engine.name,
      version: engine.version,
      invoke: engine.invoke,
      list: engine.list,
      describe: (id: string) => {
        describes += 1;
        return engine.describe(id);
      },
    } as unknown as typeof engine;
    // Principal "m<n>" sees capability i when bit i of n is set.
    const handler = createHttpHandler(counted, {
      visibility: ({ principal, capabilityId }) =>
        ((Number(principal?.id.slice(1)) >>
          ids.indexOf(capabilityId as never)) &
          1) ===
        1,
      auth: {
        mode: "required",
        authenticate: ({ headers }) => ({ id: headers.get("x-user") ?? "" }),
      },
    });
    const document = (mask: number) =>
      handler(get(`m${String(mask)}`, "/openapi.json"));

    for (let mask = 1; mask <= 65; mask += 1) await document(mask);
    const filled = describes;
    await document(65);
    expect(describes).toBe(filled);
    await document(2);
    expect(describes).toBe(filled);
    // Mask 1 was inserted first and evicted by the 65th distinct set.
    await document(1);
    expect(describes).toBeGreaterThan(filled);
  });

  it("answers a hidden ID with 404 before checking the media type or reading the body", async () => {
    const handler = handlerFor({ visibility });
    let pulled = false;
    // highWaterMark 0: the stream is pulled only when someone reads it.
    const body = new ReadableStream(
      {
        pull(controller) {
          pulled = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    const response = await handler(
      new Request("http://127.0.0.1/capabilities/billing.refund", {
        method: "POST",
        headers: { "x-user": "reader", "content-type": "text/plain" },
        body,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(404);
    expect(pulled).toBe(false);
  });

  it("applies visibility to the null principal when authentication is disabled", async () => {
    const seen: Array<Principal | null> = [];
    const handler = createHttpHandler(createVisibilityEngine(), {
      visibility: ({ principal, capabilityId }) => {
        seen.push(principal);
        return capabilityId === "billing.get-invoice";
      },
      auth: { mode: "dangerously-disabled-for-development" },
    });

    const listed = (await (
      await handler(new Request("http://127.0.0.1/capabilities"))
    ).json()) as { capabilities: { id: string }[] };

    expect(listed.capabilities.map((capability) => capability.id)).toEqual([
      "billing.get-invoice",
    ]);
    expect(seen.every((principal) => principal === null)).toBe(true);
  });

  it("passes the predicate a deep-frozen principal", async () => {
    const seen: Array<Principal | null> = [];
    const handler = handlerFor({
      visibility: (({ principal }) => {
        seen.push(principal);
        return true;
      }) satisfies HttpCapabilityVisibility,
    });

    await handler(get("admin", "/capabilities"));
    expect(seen[0]).toEqual(principals.admin);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]?.attributes)).toBe(true);
  });

  it("rejects an invalid visibility option at construction", () => {
    expect(() => handlerFor({ visibility: true })).toThrow(
      new TypeError("visibility must be a function."),
    );
  });
});
