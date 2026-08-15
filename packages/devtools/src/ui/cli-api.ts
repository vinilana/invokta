import type {
  CliActivityRecord,
  CliApi,
  CliCapabilityDescription,
  CliCapabilitySummary,
  CliConnectionState,
  CliJsonValue,
  CliSession,
} from "./cli-contract.js";

type Fetcher = typeof fetch;

export class CliApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliApiError";
    this.code = code;
  }
}

async function responseJson<Value>(response: Response): Promise<Value> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CliApiError(
      "PROTOCOL_ERROR",
      "The local interface returned an invalid response.",
    );
  }
  if (!response.ok) {
    const error = value as {
      readonly code?: unknown;
      readonly message?: unknown;
    };
    throw new CliApiError(
      typeof error.code === "string" ? error.code : "CONNECTION_FAILED",
      typeof error.message === "string"
        ? error.message
        : "The local request could not be completed.",
    );
  }
  return value as Value;
}

export function createRouteCliApi(fetcher: Fetcher = fetch): CliApi {
  let csrfToken = "";

  const get = async <Value>(path: string): Promise<Value> => {
    const response = await fetcher(path, { credentials: "same-origin" });
    return responseJson<Value>(response);
  };

  const mutate = async <Value>(
    path: string,
    method: "POST" | "DELETE",
    body?: unknown,
  ): Promise<Value> => {
    const response = await fetcher(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "X-Invokta-CSRF": csrfToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await responseJson<Value>(response);
    const replacement = response.headers.get("X-Invokta-CSRF");
    if (replacement !== null && replacement !== "") csrfToken = replacement;
    return value;
  };

  return {
    async session() {
      const response = await get<CliSession>("/api/session");
      csrfToken = response.csrfToken;
      return response;
    },
    connect: (target) =>
      mutate<CliConnectionState>("/api/connection", "POST", target),
    disconnect: () => mutate<CliConnectionState>("/api/connection", "DELETE"),
    refresh: () => mutate<CliConnectionState>("/api/refresh", "POST"),
    async catalog() {
      const response = await get<{
        readonly capabilities: readonly CliCapabilitySummary[];
      }>("/api/catalog");
      return response.capabilities;
    },
    describe: (id) =>
      mutate<CliCapabilityDescription>("/api/describe", "POST", { id }),
    async run(id, input) {
      const response = await mutate<{ readonly result: CliJsonValue }>(
        "/api/run",
        "POST",
        { id, input },
      );
      return response.result;
    },
    async activity() {
      const response = await get<{
        readonly records: readonly CliActivityRecord[];
      }>("/api/activity");
      return response.records;
    },
  };
}
