import { randomUUID } from "node:crypto";
import type {
  MessageExtraInfo,
  RequestId,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

function rewriteRequestIds(
  message: JSONRPCMessage,
  rewrite: (value: unknown) => unknown | undefined,
  topLevelIdScope: "request" | "message",
): JSONRPCMessage {
  let rewritten: JSONRPCMessage = message;
  if (
    "id" in message &&
    (topLevelIdScope === "message" || "method" in message)
  ) {
    const id = rewrite(message.id);
    if (id !== undefined) {
      rewritten = { ...message, id } as unknown as JSONRPCMessage;
    }
  }
  if ("method" in rewritten && rewritten.method === "notifications/cancelled") {
    const params = rewritten.params;
    if (params !== undefined) {
      const requestId = rewrite(params.requestId);
      if (requestId !== undefined) {
        rewritten = {
          ...rewritten,
          params: { ...params, requestId },
        } as unknown as JSONRPCMessage;
      }
    }
  }
  return rewritten;
}

class FalsyRequestIdTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  private readonly numericZeroSentinel =
    `\u0000ai-engine-request-id:${randomUUID()}:numeric-zero`;
  private readonly emptyStringSentinel =
    `\u0000ai-engine-request-id:${randomUUID()}:empty-string`;

  constructor(private readonly transport: Transport) {}

  private toInternalRequestId(value: unknown): RequestId | undefined {
    if (value === 0) return this.numericZeroSentinel;
    if (value === "") return this.emptyStringSentinel;
    return undefined;
  }

  private toExternalRequestId(value: unknown): RequestId | undefined {
    if (value === this.numericZeroSentinel) return 0;
    if (value === this.emptyStringSentinel) return "";
    return undefined;
  }

  async start(): Promise<void> {
    this.transport.onclose = () => {
      this.onclose?.();
    };
    this.transport.onerror = (error) => {
      this.onerror?.(error);
    };
    this.transport.onmessage = <T extends JSONRPCMessage>(
      message: T,
      extra?: MessageExtraInfo,
    ) => {
      this.onmessage?.(
        rewriteRequestIds(
          message,
          (value) => this.toInternalRequestId(value),
          "request",
        ) as T,
        extra,
      );
    };
    await this.transport.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const relatedRequestId = this.toExternalRequestId(
      options?.relatedRequestId,
    );
    return this.transport.send(
      rewriteRequestIds(
        message,
        (value) => this.toExternalRequestId(value),
        "message",
      ),
      relatedRequestId === undefined
        ? options
        : { ...options, relatedRequestId },
    );
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }
}

export function preserveFalsyRequestIds(transport: Transport): Transport {
  return new FalsyRequestIdTransport(transport);
}
