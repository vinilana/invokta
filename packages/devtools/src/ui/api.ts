export interface EngineInfo {
  readonly name: string;
  readonly version: string;
  readonly capabilityCount: number;
  readonly engineHost: { readonly host: string; readonly port: number };
}

export interface CapabilityInfo {
  readonly id: string;
  readonly title?: string;
  readonly description: string;
  readonly annotations?: Readonly<Record<string, boolean>>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

export interface DoctorInfo {
  readonly engineName: string;
  readonly engineVersion: string;
  readonly capabilityCount?: number;
  readonly findings: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly notes: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface PrincipalInfo {
  readonly key: string;
  readonly principal: {
    readonly id: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  };
}

export interface IssuedPrincipal extends PrincipalInfo {
  readonly token: string;
}

async function getJson<Value>(path: string): Promise<Value> {
  const response = await fetch(path);
  if (!response.ok)
    throw new Error(`${path} answered ${String(response.status)}`);
  return (await response.json()) as Value;
}

export const api = {
  engine: () => getJson<EngineInfo>("/api/engine"),
  capabilities: () => getJson<readonly CapabilityInfo[]>("/api/capabilities"),
  doctor: () => getJson<DoctorInfo>("/api/doctor"),
  principals: () => getJson<readonly PrincipalInfo[]>("/api/principals"),
  createPrincipal: async (principal: {
    readonly id: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }): Promise<IssuedPrincipal> => {
    const response = await fetch("/api/principals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal }),
    });
    if (!response.ok) throw new Error("The principal could not be created.");
    return (await response.json()) as IssuedPrincipal;
  },
  rotatePrincipal: async (key: string): Promise<IssuedPrincipal> => {
    const response = await fetch("/api/principals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!response.ok) throw new Error("The token could not be minted.");
    return (await response.json()) as IssuedPrincipal;
  },
  removePrincipal: async (key: string): Promise<void> => {
    await fetch("/api/principals", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
  },
};

export interface McpExchange {
  readonly status: number;
  readonly contentType: string | null;
  readonly requestBody: string;
  readonly responseBody: string;
}

/** Sends one raw MCP `tools/call` through the same-origin proxy. */
export async function callTool(
  capabilityId: string,
  args: unknown,
  token: string | null,
): Promise<McpExchange> {
  const requestBody = JSON.stringify(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: capabilityId, arguments: args },
    },
    null,
    2,
  );
  const response = await fetch("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: requestBody,
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    requestBody,
    responseBody: await response.text(),
  };
}
