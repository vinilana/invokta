import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const supportCapabilityId = "support.classify-ticket";

export interface HarnessMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ToolExecution {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
  readonly result: unknown;
}

export interface SupportHarnessSnapshot {
  readonly discoveredTools: readonly string[];
  readonly messages: readonly HarnessMessage[];
  readonly executions: readonly ToolExecution[];
}

const supportEngineEntrypoint = fileURLToPath(
  new URL("../../support-engine/dist/mcp-stdio.js", import.meta.url),
);

function structuredResult(result: unknown): Readonly<Record<string, unknown>> {
  if (
    typeof result !== "object" ||
    result === null ||
    !("structuredContent" in result) ||
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null ||
    Array.isArray(result.structuredContent)
  ) {
    throw new Error("The support tool returned no structured content.");
  }
  return result.structuredContent as Readonly<Record<string, unknown>>;
}

function safeToolError(result: unknown): Readonly<Record<string, unknown>> {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("The support tool returned no safe error content.");
  }
  const textContent = result.content.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string",
  );
  if (textContent === undefined) {
    throw new Error("The support tool returned no safe error content.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textContent.text) as unknown;
  } catch {
    throw new Error("The support tool returned invalid error JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("code" in parsed) ||
    typeof parsed.code !== "string" ||
    !("message" in parsed) ||
    typeof parsed.message !== "string"
  ) {
    throw new Error("The support tool returned an invalid safe error.");
  }

  return {
    code: parsed.code,
    message: parsed.message,
    ...("publicDetails" in parsed && Object.hasOwn(parsed, "publicDetails")
      ? { publicDetails: parsed.publicDetails }
      : {}),
  };
}

export class SupportHarness {
  readonly #messages: HarnessMessage[] = [];
  readonly #executions: ToolExecution[] = [];
  #discoveredTools: string[] = [];

  async classifyTicket(ticketId: string): Promise<SupportHarnessSnapshot> {
    this.#messages.push({
      role: "user",
      content: `Classify support ticket ${ticketId}.`,
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [supportEngineEntrypoint],
      stderr: "pipe",
    });
    const client = new Client(
      { name: "support-harness", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      this.#discoveredTools = tools.tools
        .map(({ name }) => name)
        .sort((left, right) => left.localeCompare(right));
      if (!this.#discoveredTools.includes(supportCapabilityId)) {
        throw new Error(`Required MCP tool not found: ${supportCapabilityId}`);
      }

      const toolArguments = { ticketId };
      const result = await client.callTool({
        name: supportCapabilityId,
        arguments: toolArguments,
      });
      const isError = result.isError === true;
      const output = isError ? safeToolError(result) : structuredResult(result);

      this.#executions.push({
        toolName: supportCapabilityId,
        arguments: toolArguments,
        isError,
        result: output,
      });
      this.#messages.push({
        role: "assistant",
        content: JSON.stringify(output),
      });

      return this.snapshot();
    } finally {
      await client.close();
    }
  }

  snapshot(): SupportHarnessSnapshot {
    return {
      discoveredTools: [...this.#discoveredTools],
      messages: this.#messages.map((message) => ({ ...message })),
      executions: this.#executions.map((execution) => ({
        ...execution,
        arguments: { ...execution.arguments },
      })),
    };
  }
}
