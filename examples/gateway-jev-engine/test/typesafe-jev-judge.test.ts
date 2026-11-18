import { EngineError } from "@invokta/core";
import { describe, expect, it } from "vitest";

import type { ToolCandidate } from "../src/application/ports.js";
import { createTypeSafeJevJudge } from "../src/infrastructure/typesafe-jev-judge.js";
import { createFakeTypeSafeFetch } from "./support/fake-typesafe-api.js";

const apiKey = "ts-test-key-0123456789";
const signal = new AbortController().signal;

function candidates(count: number): ToolCandidate[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `crm.area${String(index)}_get-record`,
    description: `Return one record of area ${String(index)}.`,
  }));
}

async function failure(pending: Promise<unknown>): Promise<EngineError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error("Expected the judgment to fail.");
}

describe("createTypeSafeJevJudge", () => {
  it("sends noul questions to /v1/systemone in the SDK's request shape", async () => {
    const fake = createFakeTypeSafeFetch({ apiKey });
    const judge = createTypeSafeJevJudge({ apiKey, fetch: fake.fetch });

    const needs = await judge.judge(
      "Cancel order O-42",
      [
        {
          id: "crm.orders_cancel-order",
          title: "Cancel order",
          description: "Cancel an order that has not completed.",
        },
        { id: "crm.orders_get-order", description: "Return one order." },
      ],
      { signal },
    );

    expect(needs).toEqual([
      { id: "crm.orders_cancel-order", probability: 0.94 },
      { id: "crm.orders_get-order", probability: 0.3 },
    ]);
    const [request] = fake.requests;
    expect(request?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body).toEqual({
      model: "jev-latest",
      state: { task: "Cancel order O-42" },
      questions: {
        tool_0: {
          type: "noul",
          instructions: {
            question: "Is this tool needed to complete the task?",
            tool: {
              id: "crm.orders_cancel-order",
              title: "Cancel order",
              description: "Cancel an order that has not completed.",
            },
          },
          criteria: {
            true: "The task cannot be completed without calling this tool.",
            false: "The task can be completed without this tool.",
          },
        },
        tool_1: expect.objectContaining({ type: "noul" }),
      },
    });
  });

  it("batches candidates with a bounded number of requests in flight", async () => {
    const fake = createFakeTypeSafeFetch({ apiKey, delayMs: 5 });
    const judge = createTypeSafeJevJudge({
      apiKey,
      fetch: fake.fetch,
      batchSize: 16,
      maxConcurrency: 2,
      baseUrl: "https://jev.internal.example/",
      model: "jev-1.14.0",
    });

    const needs = await judge.judge("Get record", candidates(40), { signal });

    expect(needs).toHaveLength(40);
    expect(fake.requests).toHaveLength(3);
    expect(fake.maxInFlight()).toBe(2);
    expect(
      fake.requests.map(
        (request) => Object.keys(request.body.questions as object).length,
      ),
    ).toEqual([16, 16, 8]);
    expect(fake.requests[0]?.url).toBe(
      "https://jev.internal.example/v1/systemone",
    );
    expect(fake.requests[0]?.body.model).toBe("jev-1.14.0");
  });

  it("fails without leaking the key or the response body", async () => {
    const rateLimited = createTypeSafeJevJudge({
      apiKey,
      fetch: createFakeTypeSafeFetch({ apiKey, status: 429 }).fetch,
    });
    const error = await failure(
      rateLimited.judge("Get record", candidates(2), { signal }),
    );

    expect(error.code).toBe("EXECUTION_FAILED");
    expect(error.message).toBe("The TypeSafe Jev request failed.");
    expect(error.publicDetails).toEqual({ status: 429 });
    expect(JSON.stringify(error)).not.toContain(apiKey);
  });

  it.each([
    { answers: {} },
    { answers: { tool_0: { type: "noul", noul: 1.5 } } },
    { answers: { tool_0: { type: "choice", choice: "true" } } },
    { nothing: true },
  ])("rejects a malformed response %#", async (body) => {
    const judge = createTypeSafeJevJudge({
      apiKey,
      fetch: createFakeTypeSafeFetch({ apiKey, body }).fetch,
    });

    expect(
      (await failure(judge.judge("Get record", candidates(1), { signal })))
        .code,
    ).toBe("EXECUTION_FAILED");
  });

  it("enforces its deadline, the caller's signal, and its bounds", async () => {
    const slow = createTypeSafeJevJudge({
      apiKey,
      timeoutMs: 20,
      fetch: createFakeTypeSafeFetch({ apiKey, delayMs: 1_000 }).fetch,
    });
    await expect(
      slow.judge("Get record", candidates(1), { signal }),
    ).rejects.toThrow("The TypeSafe Jev request failed.");

    const judge = createTypeSafeJevJudge({
      apiKey,
      maxCandidates: 10,
      fetch: createFakeTypeSafeFetch({ apiKey }).fetch,
    });
    await expect(
      judge.judge("Get record", candidates(11), { signal }),
    ).rejects.toThrow(RangeError);
    await expect(judge.judge("", candidates(1), { signal })).rejects.toThrow(
      RangeError,
    );
    await expect(judge.judge("Get record", [], { signal })).resolves.toEqual(
      [],
    );

    expect(() => createTypeSafeJevJudge({ apiKey: "" })).toThrow(TypeError);
    expect(() =>
      createTypeSafeJevJudge({ apiKey, baseUrl: "https://user:pw@x.example" }),
    ).toThrow(TypeError);
    expect(() => createTypeSafeJevJudge({ apiKey, batchSize: 65 })).toThrow(
      TypeError,
    );
  });
});
