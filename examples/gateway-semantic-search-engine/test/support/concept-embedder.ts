import { createServer } from "node:http";

import { tokenize } from "@invokta/gateway";

import type { TextEmbedder } from "../../src/application/ports.js";

/**
 * A deterministic stand-in for a multilingual embedding model: English and
 * Portuguese words for the same concept share one dimension. It shows how
 * cross-language search behaves without a network or a model; it says
 * nothing about a real model's quality.
 */
const concepts: Readonly<Record<string, ReadonlyArray<string>>> = {
  create: ["create", "criar", "cadastrar", "new", "novo", "add", "adicionar"],
  update: ["update", "atualizar", "editar", "alterar", "change", "modify"],
  delete: ["delete", "excluir", "apagar", "remover", "remove"],
  get: ["get", "return", "obter", "consultar", "show", "mostrar", "ver"],
  list: ["list", "listar", "pagination"],
  search: ["search", "buscar", "pesquisar", "procurar", "find", "keyword"],
  archive: ["archive", "arquivar"],
  export: ["export", "exportar", "csv", "download", "baixar"],
  approve: ["approve", "aprovar", "pending", "pendente"],
  cancel: ["cancel", "cancelar"],
  invoice: ["invoice", "fatura"],
  subscription: ["subscription", "assinatura"],
  customer: ["customer", "cliente"],
  account: ["account", "conta"],
  order: ["order", "pedido", "encomenda"],
  shipment: ["shipment", "remessa", "envio", "entrega"],
  ticket: ["ticket", "chamado"],
  product: ["product", "produto"],
  stock: ["stock", "estoque", "inventory"],
  payment: ["payment", "pagamento"],
  contract: ["contract", "contrato"],
  employee: ["employee", "funcionário", "colaborador"],
  project: ["project", "projeto"],
  document: ["document", "documento"],
  report: ["report", "relatório"],
  campaign: ["campaign", "campanha"],
  lead: ["lead"],
  vendor: ["vendor", "fornecedor", "supplier"],
  asset: ["asset", "ativo"],
  meeting: ["meeting", "reunião", "reuniões"],
};

const dimensionByToken = new Map<string, number>();
Object.values(concepts).forEach((words, dimension) => {
  for (const word of words) {
    for (const token of tokenize(word)) dimensionByToken.set(token, dimension);
  }
});
const dimensions = Object.keys(concepts).length;

export function conceptVector(text: string): Float32Array {
  const vector = new Float32Array(dimensions);
  for (const token of tokenize(text)) {
    const dimension = dimensionByToken.get(token);
    if (dimension !== undefined)
      vector[dimension] = (vector[dimension] ?? 0) + 1;
  }
  return vector;
}

/** The stand-in as a `TextEmbedder`, counting calls and embedded texts. */
export function createConceptEmbedder() {
  const calls: number[] = [];
  const embedder: TextEmbedder = {
    async embed(texts) {
      calls.push(texts.length);
      return texts.map(conceptVector);
    },
  };
  return { embedder, calls };
}

/** The stand-in behind the OpenAI-compatible `/embeddings` response shape. */
export function conceptEmbeddingsBody(body: unknown): unknown {
  const { input, model } = body as {
    readonly input: ReadonlyArray<string>;
    readonly model: string;
  };
  return {
    object: "list",
    model,
    data: input.map((text, index) => ({
      object: "embedding",
      index,
      embedding: [...conceptVector(text)],
    })),
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

/** A loopback OpenAI-compatible embeddings server backed by the stand-in. */
export async function startFakeEmbeddingsApi() {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.method !== "POST" || request.url !== "/v1/embeddings") {
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify(
          conceptEmbeddingsBody(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ),
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
