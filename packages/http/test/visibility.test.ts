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

  it("rejects an invalid visibility option at construction", () => {
    expect(() => handlerFor({ visibility: true })).toThrow(
      new TypeError("visibility must be a function."),
    );
  });
});
