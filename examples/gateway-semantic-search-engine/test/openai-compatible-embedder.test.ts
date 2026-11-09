import { EngineError } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { createOpenAiCompatibleEmbedder } from "../src/infrastructure/openai-compatible-embedder.js";

const signal = new AbortController().signal;

function recordingFetch(answer: (body: Record<string, unknown>) => Response) {
  const requests: Array<{
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
  }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body,
    });
    if (init?.signal?.aborted) throw init.signal.reason;
    return answer(body);
  };
  return { fetch, requests };
}

function vectorsFor(body: Record<string, unknown>, reverse = false) {
  const input = body.input as string[];
  const data = input.map((text, index) => ({
    object: "embedding",
    index,
    embedding: [text.length, index + 1],
  }));
  return Response.json({
    object: "list",
    data: reverse ? data.reverse() : data,
  });
}

async function failure(pending: Promise<unknown>): Promise<EngineError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error("Expected the embedding to fail.");
}

describe("createOpenAiCompatibleEmbedder", () => {
  it("posts the OpenAI-compatible request and orders vectors by index", async () => {
    const recorded = recordingFetch((body) => vectorsFor(body, true));
    const embedder = createOpenAiCompatibleEmbedder({
      baseUrl: "https://api.openai.com/v1/",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      dimensions: 256,
      fetch: recorded.fetch,
    });

    const vectors = await embedder.embed(["one", "three"], { signal });

    expect(vectors.map((vector) => [...vector])).toEqual([
      [3, 1],
      [5, 2],
    ]);
    expect(recorded.requests[0]?.url).toBe(
      "https://api.openai.com/v1/embeddings",
    );
    expect(recorded.requests[0]?.headers.get("authorization")).toBe(
      "Bearer sk-test",
    );
    expect(recorded.requests[0]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["one", "three"],
      encoding_format: "float",
      dimensions: 256,
    });
  });

  it("batches large inputs and sends no credential to a local server", async () => {
    const recorded = recordingFetch((body) => vectorsFor(body));
    const embedder = createOpenAiCompatibleEmbedder({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      batchSize: 64,
      fetch: recorded.fetch,
    });

    const texts = Array.from(
      { length: 130 },
      (_v, index) => `tool ${String(index)}`,
    );
    expect(await embedder.embed(texts, { signal })).toHaveLength(130);
    expect(
      recorded.requests.map(
        (request) => (request.body.input as string[]).length,
      ),
    ).toEqual([64, 64, 2]);
    expect(recorded.requests[0]?.headers.has("authorization")).toBe(false);
  });

  it.each([
    { data: [] },
    {
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 0, embedding: [1, 2] },
      ],
    },
    {
      data: [
        { index: 0, embedding: [1, Number.NaN] },
        { index: 1, embedding: [1, 2] },
      ],
    },
    {
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [1] },
      ],
    },
    { error: "no data" },
  ])("rejects a malformed response %#", async (body) => {
    const embedder = createOpenAiCompatibleEmbedder({
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      fetch: recordingFetch(
        () =>
          // JSON.stringify turns NaN into null, which is not a finite number.
          new Response(JSON.stringify(body), {
            headers: { "content-type": "application/json" },
          }),
      ).fetch,
    });

    expect((await failure(embedder.embed(["a", "b"], { signal }))).code).toBe(
      "EXECUTION_FAILED",
    );
  });

  it("reports a failed status without the key or body", async () => {
    const embedder = createOpenAiCompatibleEmbedder({
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-secret-value",
      fetch: recordingFetch(() =>
        Response.json({ error: "sk-secret-value is invalid" }, { status: 401 }),
      ).fetch,
    });

    const error = await failure(embedder.embed(["a"], { signal }));
    expect(error.publicDetails).toEqual({ status: 401 });
    expect(JSON.stringify(error)).not.toContain("sk-secret-value");
  });

  it("validates its configuration and inputs", async () => {
    expect(() =>
      createOpenAiCompatibleEmbedder({ baseUrl: "ftp://x", model: "m" }),
    ).toThrow(TypeError);
    expect(() =>
      createOpenAiCompatibleEmbedder({
        baseUrl: "https://x.example",
        model: "",
      }),
    ).toThrow(TypeError);
    const embedder = createOpenAiCompatibleEmbedder({
      baseUrl: "https://x.example",
      model: "m",
      fetch: recordingFetch((body) => vectorsFor(body)).fetch,
    });
    await expect(embedder.embed([" "], { signal })).rejects.toThrow(RangeError);
  });
});
