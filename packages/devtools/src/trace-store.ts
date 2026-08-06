import type { InvocationRecord } from "./engine-host.js";

export interface ExchangeCapture {
  readonly status: number;
  readonly durationMs: number;
  readonly mcpMethod?: string;
  readonly capabilityId?: string;
  readonly requestBody: string;
  readonly responseBody: string;
}

export type TraceEntry =
  | {
      readonly kind: "invocation";
      readonly id: number;
      readonly at: string;
      readonly invocation: InvocationRecord;
    }
  | {
      readonly kind: "exchange";
      readonly id: number;
      readonly at: string;
      readonly exchange: ExchangeCapture;
      readonly requestTruncated: boolean;
      readonly responseTruncated: boolean;
    }
  | {
      readonly kind: "notice";
      readonly id: number;
      readonly at: string;
      readonly notice: string;
    };

export interface TraceStore {
  appendInvocation(record: InvocationRecord): TraceEntry;
  appendExchange(capture: ExchangeCapture): TraceEntry;
  appendNotice(notice: string): TraceEntry;
  entries(): ReadonlyArray<TraceEntry>;
  subscribe(listener: (entry: TraceEntry) => void): () => void;
}

export interface CreateTraceStoreOptions {
  /** Oldest entries are dropped beyond this bound. Defaults to 500. */
  readonly capacity?: number;
  /** Captured bodies are truncated to this many characters. Defaults to 65536. */
  readonly maxCapturedBodyLength?: number;
}

const defaultCapacity = 500;
const defaultMaxCapturedBodyLength = 65_536;

/**
 * A bounded in-memory ring buffer of trace entries scoped to one dev-server
 * process. Nothing is persisted, aggregated, or exported; the only consumers
 * are the local interface event stream and in-process readers. Listener
 * failures never affect the writer.
 */
export function createTraceStore(
  options: CreateTraceStoreOptions = {},
): TraceStore {
  const capacity = options.capacity ?? defaultCapacity;
  const maxBodyLength =
    options.maxCapturedBodyLength ?? defaultMaxCapturedBodyLength;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new TypeError("capacity must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxBodyLength) || maxBodyLength <= 0) {
    throw new TypeError(
      "maxCapturedBodyLength must be a positive safe integer.",
    );
  }

  const buffered: TraceEntry[] = [];
  const listeners = new Set<(entry: TraceEntry) => void>();
  let nextId = 0;

  const append = (entry: TraceEntry): TraceEntry => {
    buffered.push(entry);
    if (buffered.length > capacity) buffered.shift();
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // A listener failure must not affect tracing or the invocation path.
      }
    }
    return entry;
  };

  const stamp = (): { readonly id: number; readonly at: string } => {
    nextId += 1;
    return { id: nextId, at: new Date().toISOString() };
  };

  return {
    appendInvocation: (record) =>
      append({ kind: "invocation", ...stamp(), invocation: record }),
    appendExchange: (capture) => {
      const requestTruncated = capture.requestBody.length > maxBodyLength;
      const responseTruncated = capture.responseBody.length > maxBodyLength;
      return append({
        kind: "exchange",
        ...stamp(),
        exchange: {
          ...capture,
          requestBody: requestTruncated
            ? capture.requestBody.slice(0, maxBodyLength)
            : capture.requestBody,
          responseBody: responseTruncated
            ? capture.responseBody.slice(0, maxBodyLength)
            : capture.responseBody,
        },
        requestTruncated,
        responseTruncated,
      });
    },
    appendNotice: (notice) => append({ kind: "notice", ...stamp(), notice }),
    entries: () => [...buffered],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
