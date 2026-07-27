import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { preserveFalsyRequestIds } from "../src/request-id-transport.js";

function createTransportHarness() {
  const sent: Array<{
    readonly message: JSONRPCMessage;
    readonly options?: TransportSendOptions;
  }> = [];
  const transport: Transport = {
    start: vi.fn(async () => undefined),
    async send(message, options) {
      sent.push({ message, ...(options === undefined ? {} : { options }) });
    },
    close: vi.fn(async () => undefined),
  };

  return {
    sent,
    transport,
    receive(message: JSONRPCMessage) {
      transport.onmessage?.(message);
    },
  };
}

describe("falsy request ID transport", () => {
  it.each([0, ""] as const)(
    "normalizes request ID %j without changing a response ID",
    async (externalRequestId) => {
      const harness = createTransportHarness();
      const transport = preserveFalsyRequestIds(harness.transport);
      const received: JSONRPCMessage[] = [];
      transport.onmessage = (message) => received.push(message);
      await transport.start();

      harness.receive({
        jsonrpc: "2.0",
        id: externalRequestId,
        method: "tools/list",
      });
      const normalizedRequest = received[0] as {
        readonly id: RequestId;
      };
      expect(normalizedRequest.id).not.toBe(externalRequestId);

      harness.receive({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: externalRequestId, reason: "cancel" },
      });
      expect(received[1]).toMatchObject({
        params: { requestId: normalizedRequest.id },
      });

      const response = {
        jsonrpc: "2.0" as const,
        id: externalRequestId,
        result: {},
      };
      harness.receive(response);
      expect(received[2]).toBe(response);

      await transport.send(
        {
          jsonrpc: "2.0",
          id: normalizedRequest.id,
          result: {},
        },
        { relatedRequestId: normalizedRequest.id },
      );
      expect(harness.sent).toEqual([
        {
          message: { jsonrpc: "2.0", id: externalRequestId, result: {} },
          options: { relatedRequestId: externalRequestId },
        },
      ]);
    },
  );
});
