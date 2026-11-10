import { EngineError } from "@invokta/core";

import type {
  ToolCandidate,
  ToolNeed,
  ToolNeedJudge,
} from "../application/ports.js";

/**
 * Configuration of the TypeSafe Jev connector. The request and response
 * shapes follow the `systemOne` call of the official `@typesafe-ai/sdk`
 * 0.7.0: `POST {baseUrl}/v1/systemone` with a Bearer key, a `state`, and
 * named `noul` questions answered with a yes-probability.
 */
export interface TypeSafeJevJudgeOptions {
  readonly apiKey: string;
  /** API root. Defaults to `https://api.typesafe.ai`. */
  readonly baseUrl?: string;
  /** Model name. Defaults to `jev-latest`. */
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Deadline of one request. Defaults to 10,000 ms, at most 60,000. */
  readonly timeoutMs?: number;
  /** Tools judged per request. Defaults to 16, at most 64. */
  readonly batchSize?: number;
  /** Requests in flight for one task. Defaults to 4, at most 8. */
  readonly maxConcurrency?: number;
  /** Tools judged for one task. Defaults to 256, at most 1,024. */
  readonly maxCandidates?: number;
  /** Response body limit. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
}

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const MAX_TASK_LENGTH = 2_000;

const criteria = Object.freeze({
  true: "The task cannot be completed without calling this tool.",
  false: "The task can be completed without this tool.",
});

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

function credentialFreeHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
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
  return url.href.replace(/\/+$/u, "");
}

/** A sanitized failure: the status may be public, the body and key never are. */
function jevFailure(status?: number, cause?: unknown): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message: "The TypeSafe Jev request failed.",
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
    throw new RangeError("The Jev response exceeds the byte limit.");
  }
  if (response.body === null) throw new TypeError("The Jev response is empty.");
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
      throw new RangeError("The Jev response exceeds the byte limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

/** Validates one batch's answers: a finite yes-probability per question. */
function readProbabilities(
  body: unknown,
  keys: ReadonlyArray<string>,
): ReadonlyArray<number> {
  const answers =
    typeof body === "object" && body !== null
      ? (body as { readonly answers?: unknown }).answers
      : undefined;
  if (typeof answers !== "object" || answers === null) {
    throw new TypeError("The Jev response has no answers.");
  }
  return keys.map((key) => {
    const answer = (answers as Record<string, unknown>)[key];
    const { type, noul } = (answer ?? {}) as {
      readonly type?: unknown;
      readonly noul?: unknown;
    };
    if (
      type !== "noul" ||
      typeof noul !== "number" ||
      !Number.isFinite(noul) ||
      noul < 0 ||
      noul > 1
    ) {
      throw new TypeError(`The Jev answer ${key} is not a probability.`);
    }
    return noul;
  });
}

/**
 * Asks Jev, once per candidate, whether the task needs that tool. Candidates
 * are judged in batches of named `noul` questions, with a bounded number of
 * requests in flight, each under its own deadline and the caller's signal.
 */
export function createTypeSafeJevJudge(
  options: TypeSafeJevJudgeOptions,
): ToolNeedJudge {
  if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
    throw new TypeError("A TypeSafe API key is required.");
  }
  const apiKey = options.apiKey;
  const endpoint = `${credentialFreeHttpUrl(options.baseUrl ?? DEFAULT_BASE_URL)}/v1/systemone`;
  const model = options.model ?? DEFAULT_MODEL;
  if (typeof model !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(model)) {
    throw new TypeError("model must be a model name such as jev-latest.");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = bounded(options.timeoutMs, 10_000, 60_000, "timeoutMs");
  const batchSize = bounded(options.batchSize, 16, 64, "batchSize");
  const maxConcurrency = bounded(
    options.maxConcurrency,
    4,
    8,
    "maxConcurrency",
  );
  const maxCandidates = bounded(
    options.maxCandidates,
    256,
    1_024,
    "maxCandidates",
  );
  const maxResponseBytes = bounded(
    options.maxResponseBytes,
    1_048_576,
    16_777_216,
    "maxResponseBytes",
  );

  async function judgeBatch(
    task: string,
    batch: ReadonlyArray<ToolCandidate>,
    signal: AbortSignal,
  ): Promise<ReadonlyArray<number>> {
    const keys = batch.map((_candidate, index) => `tool_${String(index)}`);
    const questions = Object.fromEntries(
      batch.map((candidate, index) => [
        keys[index],
        {
          type: "noul",
          instructions: {
            question: "Is this tool needed to complete the task?",
            tool: {
              id: candidate.id,
              ...(candidate.title === undefined
                ? {}
                : { title: candidate.title }),
              description: candidate.description,
            },
          },
          criteria,
        },
      ]),
    );
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ model, state: { task }, questions }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (cause) {
      throw jevFailure(undefined, cause);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw jevFailure(response.status);
    }
    try {
      return readProbabilities(
        await readBoundedJson(response, maxResponseBytes),
        keys,
      );
    } catch (cause) {
      throw jevFailure(undefined, cause);
    }
  }

  return Object.freeze({
    async judge(task, candidates, { signal }) {
      if (task.trim() === "" || task.length > MAX_TASK_LENGTH) {
        throw new RangeError(
          `The task must be 1-${String(MAX_TASK_LENGTH)} characters.`,
        );
      }
      if (candidates.length === 0) return [];
      if (candidates.length > maxCandidates) {
        throw new RangeError(
          `At most ${String(maxCandidates)} tools can be judged for one task.`,
        );
      }
      const batches: ToolCandidate[][] = [];
      for (let start = 0; start < candidates.length; start += batchSize) {
        batches.push(candidates.slice(start, start + batchSize));
      }
      const probabilities: number[][] = new Array(batches.length);
      // The first failed batch cancels the requests still in flight.
      const failed = new AbortController();
      const batchSignal = AbortSignal.any([signal, failed.signal]);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < batches.length && !batchSignal.aborted) {
          const index = next;
          next += 1;
          try {
            probabilities[index] = [
              ...(await judgeBatch(
                task,
                batches[index] as ToolCandidate[],
                batchSignal,
              )),
            ];
          } catch (error) {
            failed.abort();
            throw error;
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(maxConcurrency, batches.length) },
          worker,
        ),
      );
      // A cancelled task leaves batches unjudged; never report partial results.
      if (batchSignal.aborted) throw jevFailure(undefined, signal.reason);
      return candidates.map(
        (candidate, index): ToolNeed => ({
          id: candidate.id,
          probability: probabilities[Math.floor(index / batchSize)]?.[
            index % batchSize
          ] as number,
        }),
      );
    },
  } satisfies ToolNeedJudge);
}
