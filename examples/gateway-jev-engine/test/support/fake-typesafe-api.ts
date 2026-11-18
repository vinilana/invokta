import { createServer, type Server } from "node:http";

import { tokenize } from "@invokta/gateway";

/**
 * A deterministic stand-in for TypeSafe's `POST /v1/systemone`. It speaks the
 * same request and response shapes, but decides with a crude rule instead of
 * a model: a tool is needed when its action word is followed, within three
 * words, by its record type. It exists so the tests run offline; it says
 * nothing about Jev's real accuracy.
 */
export function fakeJevAnswers(body: unknown): Record<string, unknown> {
  const { state, questions, model } = body as {
    readonly state: { readonly task: string };
    readonly questions: Record<
      string,
      {
        readonly type: string;
        readonly instructions: { readonly tool: { readonly id: string } };
      }
    >;
    readonly model: string;
  };
  const task = tokenize(state.task);
  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    const match = /[._]([a-z]+)-([a-z-]+)$/u.exec(
      question.instructions.tool.id,
    );
    const action = match?.[1] ?? "";
    const object = tokenize(match?.[2] ?? "");
    const at = task.indexOf(action);
    const near =
      at >= 0 &&
      object.every((token) => {
        const found = task.indexOf(token, at + 1);
        return found > at && found - at <= 3;
      });
    const mentioned = object.every((token) => task.includes(token));
    answers[name] = {
      type: "noul",
      noul: near ? 0.94 : mentioned ? 0.3 : 0.03,
    };
  }
  return { model, answers, usage: { input_tokens: 1, output_tokens: 1 } };
}

export interface FakeTypeSafeOptions {
  readonly apiKey: string;
  /** Answer every request with this status and no answers. */
  readonly status?: number;
  /** Replace the answers with this body. */
  readonly body?: unknown;
  /** Delay every answer, honoring the request's abort signal. */
  readonly delayMs?: number;
}

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

/** A `fetch` implementation that answers like the fake API, recording requests. */
export function createFakeTypeSafeFetch(options: FakeTypeSafeOptions) {
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), headers, body });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.delayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        });
      }
      if (headers.get("authorization") !== `Bearer ${options.apiKey}`) {
        return Response.json({ error: "invalid api key" }, { status: 401 });
      }
      if (options.status !== undefined) {
        return Response.json(
          { error: `api key ${options.apiKey} must never be echoed` },
          { status: options.status },
        );
      }
      return Response.json(options.body ?? fakeJevAnswers(body));
    } finally {
      inFlight -= 1;
    }
  };
  return {
    fetch,
    requests,
    maxInFlight: () => maxInFlight,
  };
}

/** The same fake behind a real loopback HTTP listener. */
export async function startFakeTypeSafeApi(apiKey: string): Promise<{
  readonly baseUrl: string;
  readonly server: Server;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const ok =
        request.method === "POST" &&
        request.url === "/v1/systemone" &&
        request.headers.authorization === `Bearer ${apiKey}`;
      response.setHeader("content-type", "application/json");
      if (!ok) {
        response.statusCode = 401;
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify(
          fakeJevAnswers(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
