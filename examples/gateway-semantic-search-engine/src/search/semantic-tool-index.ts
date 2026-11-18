import { type DiscoveryRanker, tokenize } from "@invokta/gateway";

import type { TextEmbedder } from "../application/ports.js";

/** One published tool, as the gateway engine describes it. */
export interface ToolDocument {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
}

export interface SemanticToolIndexOptions {
  readonly embedder: TextEmbedder;
  /** Cosine similarity below which a tool does not match. Defaults to 0.3. */
  readonly minSimilarity?: number;
  /** Tools the index holds. Defaults to 1,024. */
  readonly maxTools?: number;
}

export interface SemanticToolIndex {
  /**
   * Embeds every tool once, at the composition root, before serving. A
   * catalog is frozen at startup, so its vectors never need refreshing.
   */
  prepare(
    documents: ReadonlyArray<ToolDocument>,
    options: { readonly signal: AbortSignal },
  ): Promise<number>;
  /**
   * The `rank` port of `createDiscovery`: embed the query and order the
   * caller's visible candidates by cosine similarity. The gateway drops any
   * ID that is not visible to the caller.
   */
  readonly ranker: DiscoveryRanker;
}

/** The text embedded for a tool: its ID in words, its title, its description. */
export function toolText(document: ToolDocument): string {
  return [tokenize(document.id).join(" "), document.title, document.description]
    .filter((part) => part !== undefined && part !== "")
    .join(". ");
}

function normalized(vector: Float32Array): Float32Array {
  let length = 0;
  for (const value of vector) length += value * value;
  length = Math.sqrt(length);
  if (length === 0) return vector;
  return vector.map((value) => value / length);
}

function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] as number) * (right[index] as number);
  }
  return sum;
}

export function createSemanticToolIndex(
  options: SemanticToolIndexOptions,
): SemanticToolIndex {
  const minSimilarity = options.minSimilarity ?? 0.3;
  if (
    !Number.isFinite(minSimilarity) ||
    minSimilarity < -1 ||
    minSimilarity >= 1
  ) {
    throw new TypeError("minSimilarity must be at least -1 and below 1.");
  }
  const maxTools = options.maxTools ?? 1_024;
  if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 16_384) {
    throw new TypeError("maxTools must be an integer from 1 through 16,384.");
  }
  const { embedder } = options;
  let vectors: ReadonlyMap<string, Float32Array> | undefined;

  return Object.freeze({
    async prepare(documents, { signal }) {
      if (documents.length > maxTools) {
        throw new RangeError(
          `The index holds at most ${String(maxTools)} tools.`,
        );
      }
      const embedded = await embedder.embed(documents.map(toolText), {
        signal,
      });
      const size = embedded[0]?.length;
      if (
        embedded.length !== documents.length ||
        embedded.some((vector) => vector.length !== size)
      ) {
        throw new TypeError("The embedder returned mismatched vectors.");
      }
      vectors = new Map(
        documents.map((document, index) => [
          document.id,
          normalized(embedded[index] as Float32Array),
        ]),
      );
      return vectors.size;
    },
    async ranker(query, candidates, { signal }) {
      if (vectors === undefined) {
        throw new Error("The semantic index has not been prepared.");
      }
      const [embedded] = await embedder.embed([query], { signal });
      if (embedded === undefined) throw new TypeError("No query vector.");
      const queryVector = normalized(embedded);
      const scored: Array<{
        readonly id: string;
        readonly similarity: number;
      }> = [];
      for (const candidate of candidates) {
        const vector = vectors.get(candidate.id);
        if (vector === undefined || vector.length !== queryVector.length)
          continue;
        const similarity = dot(queryVector, vector);
        if (similarity >= minSimilarity) {
          scored.push({ id: candidate.id, similarity });
        }
      }
      return scored
        .sort(
          (left, right) =>
            right.similarity - left.similarity || (left.id < right.id ? -1 : 1),
        )
        .map(({ id }) => id);
    },
  } satisfies SemanticToolIndex);
}
