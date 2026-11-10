/**
 * Engine-owned port: turns texts into embedding vectors, one per text, in
 * order. The OpenAI-compatible connector implements it for OpenAI, Ollama,
 * vLLM, LM Studio, and other servers with a `/embeddings` route; tests use a
 * deterministic stand-in.
 */
export interface TextEmbedder {
  embed(
    texts: ReadonlyArray<string>,
    options: { readonly signal: AbortSignal },
  ): Promise<ReadonlyArray<Float32Array>>;
}
