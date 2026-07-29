# Integrating a PDP through a capability access rule

Authentication establishes a `Principal`; authorization decides whether that
principal may execute a specific domain capability for its validated input.
Authorization belongs to the core invocation pipeline so direct, CLI, MCP stdio,
and MCP HTTP calls all apply the same rule before `run`.

Every capability must declare one of these access forms:

- `public`, which accepts `principal = null`;
- `authenticated`, which requires a principal;
- a function that returns `true` only when the domain operation is allowed.

The framework does not define roles, scopes, tenants, relationship graphs, a
policy language, or a Policy Decision Point (PDP) adapter. A custom engine may
interpret `Principal.attributes` locally or call any external PDP from the
function.

## A provider-neutral PDP example

Define the port in the custom engine, then inject its implementation into the
capability factory:

```ts
import {
  type AccessRule,
  defineCapability,
} from "@invokta/core";
import { z } from "zod";

declare function classifyByDomainRules(ticketId: string): string;

interface AuthorizationDecisionPoint {
  isAllowed(
    request: {
      readonly subject: {
        readonly id: string;
        readonly attributes?: Readonly<Record<string, unknown>>;
      };
      readonly action: string;
      readonly resource: {
        readonly type: "support-ticket";
        readonly id: string;
      };
    },
    options: { readonly signal: AbortSignal },
  ): Promise<boolean>;
}

function canClassifyTicket(
  pdp: AuthorizationDecisionPoint,
): AccessRule<{ ticketId: string }> {
  return async ({ principal, input, context, capabilityId }) => {
    if (principal === null) return false;

    try {
      const allowed = await pdp.isAllowed(
        {
          subject: {
            id: principal.id,
            ...(principal.attributes === undefined
              ? {}
              : { attributes: principal.attributes }),
          },
          action: capabilityId,
          resource: {
            type: "support-ticket",
            id: input.ticketId,
          },
        },
        { signal: context.signal },
      );
      return allowed === true;
    } catch {
      context.logger.warn("Authorization decision was unavailable.", {
        requestId: context.requestId,
        capabilityId,
      });
      return false;
    }
  };
}

export function createClassifyTicket(pdp: AuthorizationDecisionPoint) {
  return defineCapability({
    description: "Classify a support ticket into an operational category.",
    input: z.object({ ticketId: z.string().min(1) }),
    output: z.object({ category: z.string() }),
    access: canClassifyTicket(pdp),
    async run({ input }) {
      return { category: classifyByDomainRules(input.ticketId) };
    },
  });
}
```

`AuthorizationDecisionPoint` is an application port, not a framework type. Its
implementation is wired at the composition root through a closure or factory.
No container or runtime port registry is needed.

The support example demonstrates the same boundary in
[`classify-ticket.ts`](../examples/support-engine/src/capabilities/classify-ticket.ts)
and [`ports.ts`](../examples/support-engine/src/application/ports.ts).

## Fail closed

The typed access-function contract returns a boolean. Return `true` only for an
explicit allow decision, and apply these rules:

- return `false` immediately when the operation requires identity and the
  principal is absent;
- treat an explicit PDP denial as `false`;
- catch PDP unavailability, timeout, malformed response, or other uncertainty
  and return `false` when the domain policy is fail-closed;
- configure a finite timeout in the PDP client and propagate
  `context.signal` to its I/O;
- never fall back from a failed PDP call to `authenticated`, a role guess, or a
  permissive cached value unless the domain owns and tests that policy;
- keep the decision mapping deterministic and cover allow, deny, no principal,
  and PDP failure in tests.

If a rule returns `false` without a principal, the core reports
`UNAUTHENTICATED`. If it returns `false` with a principal, the core reports
`FORBIDDEN`. In both cases, `run` is not called. If an access function throws
instead of converting uncertainty to a denial, the runtime normalizes the
unexpected failure as `EXECUTION_FAILED`; that behavior is not a grant, but it
does not express a deliberate authorization denial.

The capability timeout is applied to `run`, after access enforcement. Therefore
the PDP integration must own its network timeout rather than assuming
`timeoutMs` on the capability bounds the authorization call.

## Shape identity for the domain

`Principal` deliberately standardizes only:

```ts
interface Principal {
  readonly id: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}
```

Map only verified, authorization-relevant values into `attributes`. Do not copy
an entire provider token or claim set by default. The access rule, not the
framework, decides whether a value represents a scope, role, tenant, group, or
relationship.

The business input cannot choose or override the principal. Even when an input
schema contains fields named `principal`, `actor`, or `role`, they remain
ordinary domain data and do not replace `context.principal`.

The input and identity supplied to an access rule are request-scoped snapshots.
The runtime gives `run` independent execution snapshots, so changing nested
input or principal properties inside the rule does not change what the handler
observes. A caller also cannot alter execution by mutating validator-owned input
or principal attributes while an asynchronous access decision is pending.

A non-null principal must be structured-cloneable, have a non-empty string `id`,
and use a record for optional `attributes`. Treat token objects, live SDK
instances, functions, and other uncloneable values as boundary concerns; map
only the normalized identity data into `Principal`. Invalid identity fails as
`UNAUTHENTICATED` before the access rule and handler.

## Keep error details private

Return a boolean from the access function; do not expose the policy document,
relationship graph, provider response, credential, or internal denial reason in
`publicDetails`. Safe operational logs may include a request ID, capability ID,
and a coarse outcome, but must exclude tokens and sensitive business payloads.

Over MCP, a domain denial is a tool execution result with `isError: true` and the
safe `FORBIDDEN` error representation. Over Streamable HTTP it remains inside an
HTTP 200 MCP response. HTTP 403 is reserved by this adapter for Host or Origin
boundary rejection, not capability policy.

## Test the boundary directly

The smallest authorization test creates the capability with a fake PDP, builds
the engine, and calls `engine.invoke`. Assert that:

1. validated input is sent to the PDP;
2. the trusted principal comes from invocation options;
3. allow calls `run` once;
4. deny, no identity, timeout, and PDP failure never call `run`;
5. the result is the expected `UNAUTHENTICATED`, `FORBIDDEN`, or safe failure.

Adapter tests then need only prove that each boundary supplies the intended
principal and calls `engine.invoke`; they must not duplicate the domain policy.
