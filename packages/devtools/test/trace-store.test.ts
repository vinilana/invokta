import { describe, expect, it } from "vitest";

import type { InvocationRecord } from "../src/engine-host.js";
import { createTraceStore } from "../src/trace-store.js";

function record(sequence: number): InvocationRecord {
  return {
    sequence,
    capabilityId: "fixture.echo",
    startedAt: "2026-08-05T00:00:00.000Z",
    durationMs: 1,
    outcome: "completed",
  };
}

describe("createTraceStore", () => {
  it("assigns monotonic ids and keeps entries in arrival order", () => {
    const store = createTraceStore();
    store.appendInvocation(record(1));
    store.appendExchange({
      status: 200,
      durationMs: 2,
      mcpMethod: "tools/call",
      capabilityId: "fixture.echo",
      requestBody: "{}",
      responseBody: "{}",
    });
    store.appendNotice("engine-restarted");

    const entries = store.entries();
    expect(entries.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "invocation",
      "exchange",
      "notice",
    ]);
  });

  it("drops the oldest entries beyond the capacity bound", () => {
    const store = createTraceStore({ capacity: 3 });
    for (let index = 1; index <= 5; index += 1) {
      store.appendInvocation(record(index));
    }

    const entries = store.entries();
    expect(entries).toHaveLength(3);
    expect(
      entries.map((entry) =>
        entry.kind === "invocation" ? entry.invocation.sequence : -1,
      ),
    ).toEqual([3, 4, 5]);
  });

  it("truncates captured bodies and flags the truncation", () => {
    const store = createTraceStore({ maxCapturedBodyLength: 4 });
    const entry = store.appendExchange({
      status: 200,
      durationMs: 1,
      requestBody: "123456789",
      responseBody: "ok",
    });

    expect(entry.kind).toBe("exchange");
    if (entry.kind !== "exchange") return;
    expect(entry.exchange.requestBody).toBe("1234");
    expect(entry.requestTruncated).toBe(true);
    expect(entry.exchange.responseBody).toBe("ok");
    expect(entry.responseTruncated).toBe(false);
  });

  it("records the original character count of truncated bodies only", () => {
    const store = createTraceStore({ maxCapturedBodyLength: 4 });
    const entry = store.appendExchange({
      status: 200,
      durationMs: 1,
      requestBody: "123456789",
      responseBody: "ok",
    });

    expect(entry.kind).toBe("exchange");
    if (entry.kind !== "exchange") return;
    expect(entry.requestOriginalSize).toBe(9);
    expect(entry.responseOriginalSize).toBeUndefined();
  });

  it("records an emulated call with its adapter and truncates its bodies", () => {
    const store = createTraceStore({ maxCapturedBodyLength: 4 });
    const entry = store.appendAdapterCall({
      adapter: "cli",
      capabilityId: "fixture.echo",
      outcome: "capability-error",
      durationMs: 12,
      errorCode: "INPUT_INVALID",
      request: "engine run fixture.echo",
      response: "ok",
      exitCode: 1,
      command: "engine run fixture.echo",
    });

    expect(entry.kind).toBe("adapter");
    if (entry.kind !== "adapter") return;
    expect(entry.call.adapter).toBe("cli");
    expect(entry.call.outcome).toBe("capability-error");
    expect(entry.call.errorCode).toBe("INPUT_INVALID");
    expect(entry.call.exitCode).toBe(1);
    expect(entry.call.request).toBe("engi");
    expect(entry.requestTruncated).toBe(true);
    // The truncation badge names how much was cut, same as an exchange.
    expect(entry.requestOriginalSize).toBe("engine run fixture.echo".length);
    expect(entry.call.response).toBe("ok");
    expect(entry.responseTruncated).toBe(false);
    expect(entry.responseOriginalSize).toBeUndefined();
  });

  it("keeps the invocation input only while it still parses whole", () => {
    const store = createTraceStore({ maxCapturedBodyLength: 16 });
    const shared = {
      adapter: "cli",
      capabilityId: "fixture.echo",
      outcome: "success",
      durationMs: 1,
      request: "engine run fixture.echo",
      response: "{}",
    } as const;

    const kept = store.appendAdapterCall({ ...shared, input: '{"ok":true}' });
    expect(kept.kind).toBe("adapter");
    if (kept.kind !== "adapter") return;
    expect(kept.call.input).toBe('{"ok":true}');

    // A truncated input would no longer parse, so it is dropped instead of
    // being offered as a reproduction that silently rewrites the call.
    const dropped = store.appendAdapterCall({
      ...shared,
      input: `{"message":"${"x".repeat(32)}"}`,
    });
    expect(dropped.kind).toBe("adapter");
    if (dropped.kind !== "adapter") return;
    expect(dropped.call.input).toBeUndefined();
  });

  it("records the identity an emulated call acted as, including anonymous", () => {
    const store = createTraceStore();
    const shared = {
      adapter: "direct",
      capabilityId: "fixture.echo",
      outcome: "success",
      durationMs: 3,
      request: "{}",
      response: "{}",
    } as const;

    const named = store.appendAdapterCall({
      ...shared,
      principalId: "local:operations-analyst",
    });
    const anonymous = store.appendAdapterCall({ ...shared, principalId: null });

    expect(named.kind).toBe("adapter");
    if (named.kind !== "adapter") return;
    expect(named.call.principalId).toBe("local:operations-analyst");
    expect(anonymous.kind).toBe("adapter");
    if (anonymous.kind !== "adapter") return;
    expect(anonymous.call.principalId).toBeNull();
  });

  it("clears buffered entries while keeping ids monotonic", () => {
    const store = createTraceStore();
    store.appendInvocation(record(1));
    store.appendNotice("engine-restarted");

    store.clear();

    expect(store.entries()).toEqual([]);
    expect(store.appendInvocation(record(2)).id).toBe(3);
  });

  it("carries an optional notice detail and omits an empty one", () => {
    const store = createTraceStore();

    expect(store.appendNotice("build-failed", "error TS2322")).toMatchObject({
      kind: "notice",
      notice: "build-failed",
      detail: "error TS2322",
    });
    expect(store.appendNotice("engine-restarted")).not.toHaveProperty("detail");
    expect(store.appendNotice("engine-restarted", "")).not.toHaveProperty(
      "detail",
    );
  });

  it("notifies subscribers and isolates their failures", () => {
    const store = createTraceStore();
    const seen: number[] = [];
    store.subscribe(() => {
      throw new Error("listener failure");
    });
    const unsubscribe = store.subscribe((entry) => {
      seen.push(entry.id);
    });

    store.appendInvocation(record(1));
    unsubscribe();
    store.appendInvocation(record(2));

    expect(seen).toEqual([1]);
    expect(store.entries()).toHaveLength(2);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => createTraceStore({ capacity: 0 })).toThrow(TypeError);
  });
});
