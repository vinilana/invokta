import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

const generatedData = Buffer.from("stub generated png").toString("base64");

export interface ProviderStubRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly geminiApiKey: string | undefined;
  readonly body: string;
}

export interface ProviderStub {
  readonly openAiBaseUrl: string;
  readonly seedreamBaseUrl: string;
  readonly geminiBaseUrl: string;
  readonly generatedData: string;
  readonly requests: ReadonlyArray<ProviderStubRequest>;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body;
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  body: unknown,
): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function startProviderStub(): Promise<ProviderStub> {
  const requests: ProviderStubRequest[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://stub.local").pathname;
    const body = await readBody(request);
    requests.push({
      method: request.method ?? "",
      path,
      authorization: request.headers.authorization,
      geminiApiKey:
        typeof request.headers["x-goog-api-key"] === "string"
          ? request.headers["x-goog-api-key"]
          : undefined,
      body,
    });

    if (
      path === "/openai/v1/images/generations" ||
      path === "/openai/v1/images/edits"
    ) {
      sendJson(response, { data: [{ b64_json: generatedData }] });
      return;
    }
    if (path === "/ark/api/v3/images/generations") {
      const payload = JSON.parse(body) as {
        readonly sequential_image_generation_options?: {
          readonly max_images?: number;
        };
      };
      const count =
        payload.sequential_image_generation_options?.max_images ?? 1;
      sendJson(response, {
        data: Array.from({ length: count }, () => ({
          b64_json: generatedData,
        })),
      });
      return;
    }
    if (path === "/gemini/v1beta/interactions") {
      sendJson(response, {
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "image",
                mime_type: "image/png",
                data: generatedData,
              },
            ],
          },
        ],
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Provider stub did not bind a TCP port.");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    openAiBaseUrl: `${origin}/openai/v1`,
    seedreamBaseUrl: `${origin}/ark/api/v3`,
    geminiBaseUrl: `${origin}/gemini/v1beta`,
    generatedData,
    requests,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}
