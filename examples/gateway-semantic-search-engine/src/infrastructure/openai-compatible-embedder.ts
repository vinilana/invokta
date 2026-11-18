import { EngineError } from "@invokta/core";

import type { TextEmbedder } from "../application/ports.js";

/**
 * Configuration of an embeddings connector for the OpenAI-compatible
 * `POST {baseUrl}/embeddings` route: `{ model, input: string[] }` answered
 * with `{ data: [{ index, embedding: number[] }] }`. OpenAI, Ollama, vLLM,
 * and LM Studio serve this route.
 */
export interface OpenAiCompatibleEmbedderOptions {
  /** For example `https://api.openai.com/v1` or `http://127.0.0.1:11434/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Sent as a Bearer token when present; local servers often need none. */
  readonly apiKey?: string;
  /** Requested vector size, for models that accept `dimensions`. */
  readonly dimensions?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Texts per request. Defaults to 64, at most 256. */
  readonly batchSize?: number;
  /** Deadline of one request. Defaults to 15,000 ms, at most 120,000. */
  readonly timeoutMs?: number;
  /** Response body limit. Defaults to 16 MiB. */
  readonly maxResponseBytes?: number;
}

const MAX_TEXT_LENGTH = 8_000;

function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(
      `${name} must be an integer from 1 through ${String(maximum)}.`,
    );
  }
  return resolved;
}

function endpointFrom(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "baseUrl must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  return `${url.href.replace(/\/+$/u, "")}/embeddings`;
}

/** A sanitized failure: the status may be public, the body and key never are. */
function embeddingFailure(status?: number, cause?: unknown): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "The embeddings request failed.",
    ...(status === undefined ? {} : { publicDetails: { status } }),
    ...(cause === undefined ? {} : { cause }),
  });
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RangeError("The embeddings response exceeds the byte limit.");
  }
  if (response.body === null) {
    throw new TypeError("The embeddings response is empty.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError("The embeddings response exceeds the byte limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

/** Validates one batch: exactly one finite vector per input, all the same size. */
function readVectors(body: unknown, count: number): Float32Array[] {
  const data =
    typeof body === "object" && body !== null
      ? (body as { readonly data?: unknown }).data
      : undefined;
  if (!Array.isArray(data) || data.length !== count) {
    throw new TypeError("The embeddings response has the wrong item count.");
  }
  const vectors: Array<Float32Array | undefined> = new Array(count);
  for (const item of data) {
    const { index, embedding } = (item ?? {}) as {
      readonly index?: unknown;
      readonly embedding?: unknown;
    };
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= count ||
      vectors[index] !== undefined ||
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    ) {
      throw new TypeError("The embeddings response has an invalid item.");
    }
    vectors[index] = Float32Array.from(embedding as number[]);
  }
  const size = vectors[0]?.length;
  if (vectors.some((vector) => vector?.length !== size)) {
    throw new TypeError("The embeddings response mixes vector sizes.");
  }
  return vectors as Float32Array[];
}

export function createOpenAiCompatibleEmbedder(
  options: OpenAiCompatibleEmbedderOptions,
): TextEmbedder {
  const endpoint = endpointFrom(options.baseUrl);
  if (typeof options.model !== "string" || options.model.trim() === "") {
    throw new TypeError("An embeddings model is required.");
  }
  const { model, apiKey } = options;
  if (apiKey !== undefined && apiKey.trim() === "") {
    throw new TypeError("apiKey must not be blank.");
  }
  const dimensions =
    options.dimensions === undefined
      ? undefined
      : bounded(options.dimensions, 1, 16_384, "dimensions");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const batchSize = bounded(options.batchSize, 64, 256, "batchSize");
  const timeoutMs = bounded(options.timeoutMs, 15_000, 120_000, "timeoutMs");
  const maxResponseBytes = bounded(
    options.maxResponseBytes,
    16_777_216,
    67_108_864,
    "maxResponseBytes",
  );

  async function embedBatch(
    texts: ReadonlyArray<string>,
    signal: AbortSignal,
  ): Promise<Float32Array[]> {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...(apiKey === undefined
            ? {}
            : { authorization: `Bearer ${apiKey}` }),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model,
          input: texts,
          encoding_format: "float",
          ...(dimensions === undefined ? {} : { dimensions }),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (cause) {
      throw embeddingFailure(undefined, cause);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw embeddingFailure(response.status);
    }
    try {
      return readVectors(
        await readBoundedJson(response, maxResponseBytes),
        texts.length,
      );
    } catch (cause) {
      throw embeddingFailure(undefined, cause);
    }
  }

  return Object.freeze({
    async embed(texts, { signal }) {
      if (
        texts.some(
          (text) => text.trim() === "" || text.length > MAX_TEXT_LENGTH,
        )
      ) {
        throw new RangeError(
          `Every text must be 1-${String(MAX_TEXT_LENGTH)} characters.`,
        );
      }
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        vectors.push(
          ...(await embedBatch(texts.slice(start, start + batchSize), signal)),
        );
      }
      return vectors;
    },
  } satisfies TextEmbedder);
}
