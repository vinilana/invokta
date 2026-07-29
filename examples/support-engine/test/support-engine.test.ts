import type { EngineError, Principal } from "@invokta/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  PermissionChecker,
  TicketClassifier,
  TicketRepository,
} from "../src/application/ports.js";
import { createClassifyTicket } from "../src/capabilities/classify-ticket.js";
import type { TicketClassification } from "../src/domain/ticket.js";
import { createSupportEngine } from "../src/engine.js";
import { createAttributePermissionChecker } from "../src/infrastructure/attribute-permission-checker.js";

const principal: Principal = { id: "agent:42" };

function createDependencies() {
  const tickets: TicketRepository = {
    findById: vi.fn(async (ticketId) => ({
      id: ticketId,
      subject: "Duplicate invoice",
      body: "I was charged twice for the same invoice.",
    })),
  };
  const classifier: TicketClassifier = {
    classify: vi.fn(async () => ({
      category: "billing" as const,
      confidence: 0.98,
      rationale: "The ticket reports a duplicate charge.",
    })),
  };
  const permissions: PermissionChecker = {
    can: vi.fn(async () => true),
  };
  return { tickets, classifier, permissions };
}

describe("the support engine example", () => {
  it("classifies a ticket through the direct engine with closure-injected ports", async () => {
    const dependencies = createDependencies();
    const engine = createSupportEngine(dependencies);

    const result = await engine.invoke(
      "support.classify-ticket",
      { ticketId: " T-123 " },
      { source: "direct", principal },
    );

    expectTypeOf(result).toEqualTypeOf<{
      category: "billing" | "technical" | "commercial" | "other";
      confidence: number;
      rationale: string;
    }>();
    expect(result).toEqual({
      category: "billing",
      confidence: 0.98,
      rationale: "The ticket reports a duplicate charge.",
    });
    expect(dependencies.permissions.can).toHaveBeenCalledExactlyOnceWith(
      principal,
      "ticket:classify",
      "T-123",
    );
    expect(dependencies.tickets.findById).toHaveBeenCalledExactlyOnceWith(
      "T-123",
    );
    expect(dependencies.classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({ id: "T-123" }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("enforces domain authorization before loading or classifying the ticket", async () => {
    const dependencies = createDependencies();
    dependencies.permissions.can = vi.fn(async () => false);
    const engine = createSupportEngine(dependencies);

    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-123" },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dependencies.tickets.findById).not.toHaveBeenCalled();
    expect(dependencies.classifier.classify).not.toHaveBeenCalled();
  });

  it("fails closed when a principal has a malformed resource constraint", async () => {
    const engine = createSupportEngine({
      ...createDependencies(),
      permissions: createAttributePermissionChecker(),
    });

    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-123" },
        {
          source: "direct",
          principal: {
            id: "agent:malformed",
            attributes: {
              permissions: ["ticket:classify"],
              allowedTicketIds: "T-123",
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("validates and transforms input before consulting the permission port", async () => {
    const dependencies = createDependencies();
    const engine = createSupportEngine(dependencies);

    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "   " },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(dependencies.permissions.can).not.toHaveBeenCalled();
    expect(dependencies.tickets.findById).not.toHaveBeenCalled();
  });

  it("returns a safe domain error when the requested ticket does not exist", async () => {
    const dependencies = createDependencies();
    dependencies.tickets.findById = vi.fn(async () => null);
    const engine = createSupportEngine(dependencies);

    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-404" },
        { source: "direct", principal },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EngineError>>({
        code: "EXECUTION_FAILED",
        message: "Ticket not found.",
        publicDetails: { ticketId: "T-404" },
      }),
    );
    expect(dependencies.classifier.classify).not.toHaveBeenCalled();
  });

  it("rejects an invalid classifier result at the output contract", async () => {
    const dependencies = createDependencies();
    dependencies.classifier.classify = vi.fn(
      async () =>
        ({
          category: "billing",
          confidence: 2,
          rationale: "Invalid confidence for the contract test.",
        }) as TicketClassification,
    );
    const engine = createSupportEngine(dependencies);

    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-123" },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });

  it("propagates caller cancellation to the classifier port", async () => {
    const dependencies = createDependencies();
    let classifierSignal: AbortSignal | undefined;
    dependencies.classifier.classify = vi.fn(async (_ticket, { signal }) => {
      classifierSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return {
        category: "other" as const,
        confidence: 0,
        rationale: "Unreachable.",
      };
    });
    const engine = createSupportEngine(dependencies);
    const controller = new AbortController();

    const invocation = engine.invoke(
      "support.classify-ticket",
      { ticketId: "T-123" },
      { source: "direct", principal, signal: controller.signal },
    );
    await vi.waitFor(() => expect(classifierSignal).toBeDefined());
    controller.abort(new Error("Caller disconnected."));

    await expect(invocation).rejects.toMatchObject({ code: "CANCELLED" });
    expect(classifierSignal?.aborted).toBe(true);
  });

  it("publishes stable object schemas and operational annotations", () => {
    const engine = createSupportEngine(createDependencies());
    const description = engine.describe("support.classify-ticket");

    expect(description).toMatchObject({
      id: "support.classify-ticket",
      title: "Classify ticket",
      description: "Classify a support ticket into an operational category.",
      timeoutMs: 30_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
      },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(description.inputSchema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        ticketId: { type: "string", minLength: 1 },
      },
      required: ["ticketId"],
    });
  });

  it("builds the capability independently of the composition root", () => {
    const capability = createClassifyTicket(createDependencies());

    expect(capability.description).toBe(
      "Classify a support ticket into an operational category.",
    );
    expect(capability.access).toBeTypeOf("function");
    expect(capability.run).toBeTypeOf("function");
  });
});
