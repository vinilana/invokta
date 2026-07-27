import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import {
  createEngine,
  defineCapability,
  type ExecutionContext,
} from "../src/index.js";

interface Ticket {
  readonly id: string;
  readonly body: string;
}

interface TicketRepository {
  load(ticketId: string): Promise<Ticket>;
}

const inputSchema = z.object({
  ticketId: z
    .string()
    .transform((ticketId) => ticketId.trim())
    .pipe(z.string().min(1)),
});

const outputSchema = z.object({
  ticketId: z.string(),
  category: z
    .string()
    .transform((category) => category.toUpperCase())
    .pipe(z.enum(["BILLING", "TECHNICAL"])),
});

function classifyTicket(
  repository: TicketRepository,
  access: "public" | "authenticated",
  observeContext?: (context: ExecutionContext) => void,
) {
  return defineCapability({
    description: "Classify a support ticket by its domain content.",
    input: inputSchema,
    output: outputSchema,
    access,
    async run({ input, context }) {
      observeContext?.(context);
      const ticket = await repository.load(input.ticketId);
      return {
        ticketId: ticket.id,
        category: ticket.body.includes("invoice") ? "billing" : "technical",
      };
    },
  });
}

function supportEngine(capability: ReturnType<typeof classifyTicket>) {
  return createEngine({
    name: "support-engine",
    version: "1.0.0",
    capabilities: {
      "support.classify-ticket": capability,
    },
  });
}

describe("the M0 engine walking skeleton", () => {
  it("invokes a public domain capability with its closure-injected dependency", async () => {
    const load = vi.fn(async (ticketId: string) => ({
      id: ticketId,
      body: "The invoice total is incorrect.",
    }));
    const engine = supportEngine(classifyTicket({ load }, "public"));

    const result = await engine.invoke("support.classify-ticket", {
      ticketId: " T-42 ",
    });

    expectTypeOf(result).toEqualTypeOf<{
      ticketId: string;
      category: "BILLING" | "TECHNICAL";
    }>();
    expect(result).toEqual({ ticketId: "T-42", category: "BILLING" });
    expect(load).toHaveBeenCalledExactlyOnceWith("T-42");
  });

  it("invokes an authenticated capability when a principal is present", async () => {
    const load = vi.fn(async (ticketId: string) => ({
      id: ticketId,
      body: "The application crashes during checkout.",
    }));
    const observeContext = vi.fn();
    const engine = supportEngine(
      classifyTicket({ load }, "authenticated", observeContext),
    );
    const signal = new AbortController().signal;

    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-43" },
        {
          requestId: "request-43",
          source: "direct",
          principal: { id: "agent-7" },
          signal,
        },
      ),
    ).resolves.toEqual({ ticketId: "T-43", category: "TECHNICAL" });
    expect(load).toHaveBeenCalledExactlyOnceWith("T-43");
    expect(observeContext).toHaveBeenCalledTimes(1);
    const context = observeContext.mock.calls[0]?.[0];
    expect(context?.requestId).toBe("request-43");
    expect(context?.source).toBe("direct");
    expect(context?.principal).toEqual({ id: "agent-7" });
    expect(context?.signal).toBe(signal);
    expect(context?.logger.debug).toBeTypeOf("function");
    expect(context?.logger.info).toBeTypeOf("function");
    expect(context?.logger.warn).toBeTypeOf("function");
    expect(context?.logger.error).toBeTypeOf("function");
  });

  it("rejects invalid transformed input before executing the capability", async () => {
    const load = vi.fn(async (ticketId: string) => ({
      id: ticketId,
      body: "The invoice is missing.",
    }));
    const engine = supportEngine(classifyTicket({ load }, "public"));

    await expect(
      engine.invoke("support.classify-ticket", { ticketId: "   " }),
    ).rejects.toThrow("Capability input validation failed.");
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects invalid output returned by the capability", async () => {
    const invalidCapability = defineCapability({
      description:
        "Return an invalid support classification for contract testing.",
      input: inputSchema,
      output: outputSchema,
      access: "public",
      run: async ({ input }) =>
        ({ ticketId: input.ticketId, category: 42 }) as unknown as {
          ticketId: string;
          category: string;
        },
    });
    const engine = createEngine({
      name: "invalid-support-engine",
      version: "1.0.0",
      capabilities: { "support.classify-ticket": invalidCapability },
    });

    await expect(
      engine.invoke("support.classify-ticket", { ticketId: "T-44" }),
    ).rejects.toThrow("Capability output validation failed.");
  });

  it("denies an unauthenticated invocation before running the capability", async () => {
    const load = vi.fn(async (ticketId: string) => ({
      id: ticketId,
      body: "The invoice is missing.",
    }));
    const engine = supportEngine(classifyTicket({ load }, "authenticated"));

    await expect(
      engine.invoke("support.classify-ticket", { ticketId: "T-45" }),
    ).rejects.toThrow("Authentication is required.");
    expect(load).not.toHaveBeenCalled();
  });
});
