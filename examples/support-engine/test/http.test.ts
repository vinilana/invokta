import type { HttpAuthenticationRequest } from "@invokta/http";
import type { McpHttpAuthenticationRequest } from "@invokta/mcp";
import { describe, expect, expectTypeOf, it } from "vitest";

import { engine } from "../src/engine.js";
import { createSupportHttpHandler } from "../src/http.js";

const token = "test-only-support-token";
const handler = createSupportHttpHandler({ expectedBearerToken: token });
const capabilityPath = "/capabilities/support.classify-ticket";

function request(
  path: string,
  init: RequestInit & { readonly token?: string } = {},
): Request {
  const { token: bearer, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (bearer !== undefined) headers.set("authorization", `Bearer ${bearer}`);
  return new Request(new URL(path, "http://127.0.0.1:3001"), {
    ...rest,
    headers,
  });
}

function classify(input: unknown, bearer: string | null = token) {
  return request(capabilityPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(bearer === null ? {} : { token: bearer }),
  });
}

describe("support engine plain HTTP handler", () => {
  it("shares one authentication request shape with MCP HTTP", () => {
    expectTypeOf<HttpAuthenticationRequest>().toEqualTypeOf<McpHttpAuthenticationRequest>();
    expectTypeOf<McpHttpAuthenticationRequest>().toExtend<HttpAuthenticationRequest>();
    expectTypeOf<HttpAuthenticationRequest>().toExtend<McpHttpAuthenticationRequest>();
  });

  it("requires the bearer token on every route", async () => {
    for (const unauthenticated of [
      request("/capabilities"),
      request("/openapi.json", { token: "invalid" }),
      classify({ ticketId: "T-123" }, null),
    ]) {
      const response = await handler(unauthenticated);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("lists, describes, and invokes the same capability", async () => {
    const listed = await handler(request("/capabilities", { token }));
    expect(await listed.json()).toEqual({ capabilities: engine.list() });

    const described = await handler(request(capabilityPath, { token }));
    expect(await described.json()).toEqual(
      engine.describe("support.classify-ticket"),
    );

    const invoked = await handler(classify({ ticketId: "T-123" }));
    expect(invoked.status).toBe(200);
    expect(await invoked.json()).toEqual({
      category: "billing",
      confidence: 0.9,
      rationale: "The ticket contains language associated with billing.",
    });
  });

  it("keeps authorization in the capability and ignores identity in the body", async () => {
    const response = await handler(
      classify({
        ticketId: "T-999",
        principal: {
          id: "attacker",
          attributes: { allowedTicketIds: ["T-999"] },
        },
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(403);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(text).not.toContain("attacker");
  });

  it("returns the declared domain error as 422", async () => {
    const response = await handler(classify({ ticketId: "T-404" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "DOMAIN_ERROR",
        message: "The requested ticket does not exist.",
        publicDetails: {
          code: "TICKET_NOT_FOUND",
          retryable: false,
          details: { ticketId: "T-404" },
        },
      },
    });
  });

  it("publishes the capability contract as OpenAPI", async () => {
    const response = await handler(request("/openapi.json", { token }));
    const document = (await response.json()) as {
      readonly openapi: string;
      readonly paths: Readonly<Record<string, unknown>>;
      readonly components: {
        readonly schemas: Readonly<Record<string, unknown>>;
      };
    };

    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toContain(capabilityPath);
    expect(
      document.components.schemas["support.classify-ticket.Input"],
    ).toEqual(engine.describe("support.classify-ticket").inputSchema);
    expect(
      document.components.schemas[
        "support.classify-ticket.Error.TICKET_NOT_FOUND"
      ],
    ).toEqual(
      engine.describe("support.classify-ticket").errors?.[0]?.detailsSchema,
    );
  });
});
