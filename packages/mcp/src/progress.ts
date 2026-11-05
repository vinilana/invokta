import type { ProgressReport } from "@invokta/core";

/** The MCP `ProgressToken`: a string or an integer chosen by the client. */
export type McpProgressToken = string | number;

/**
 * A string token is echoed in every notification, so a longer value is not
 * honored and the call runs without progress notifications.
 */
const MAX_PROGRESS_TOKEN_LENGTH = 256;

/** Minimum delay between two progress notifications for one request. */
export const MIN_PROGRESS_NOTIFICATION_INTERVAL_MS = 100;

export interface McpProgressNotificationParams {
  readonly progressToken: McpProgressToken;
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface McpProgressForwarder {
  readonly report: (report: ProgressReport) => void;
  readonly close: () => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the `_meta.progressToken` of request params when it is a string of at
 * most 256 UTF-16 code units or a safe integer; otherwise `undefined`.
 */
export function readProgressToken(
  params: unknown,
): McpProgressToken | undefined {
  if (!isRecord(params)) return undefined;
  const meta = params._meta;
  if (!isRecord(meta)) return undefined;
  const token = meta.progressToken;
  if (typeof token === "string") {
    return token.length <= MAX_PROGRESS_TOKEN_LENGTH ? token : undefined;
  }
  return Number.isSafeInteger(token) ? (token as number) : undefined;
}

/**
 * Reports whether one parsed JSON-RPC message is a `tools/call` request whose
 * progress token the protocol server will honor.
 */
export function requestsProgressNotifications(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.method === "tools/call" &&
    "id" in message &&
    readProgressToken(message.params) !== undefined
  );
}

/**
 * Forwards accepted progress reports as notifications for one request. At most
 * one notification is sent per interval; a burst inside the interval is
 * coalesced to its latest report, which is flushed when the interval ends
 * unless the forwarder has been closed. Send failures are contained.
 */
export function createProgressForwarder(
  progressToken: McpProgressToken,
  send: (params: McpProgressNotificationParams) => Promise<void>,
): McpProgressForwarder {
  let closed = false;
  let lastSentAt: number | undefined;
  let pending: ProgressReport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deliver = (report: ProgressReport): void => {
    lastSentAt = performance.now();
    try {
      void send({
        progressToken,
        progress: report.progress,
        ...(report.total === undefined ? {} : { total: report.total }),
        ...(report.message === undefined ? {} : { message: report.message }),
      }).catch(() => undefined);
    } catch {
      // A closed or failing transport cannot change the tool result.
    }
  };
  const flush = (): void => {
    timer = undefined;
    const report = pending;
    pending = undefined;
    if (!closed && report !== undefined) deliver(report);
  };

  return Object.freeze({
    report(report: ProgressReport): void {
      if (closed) return;
      const wait =
        lastSentAt === undefined
          ? 0
          : lastSentAt +
            MIN_PROGRESS_NOTIFICATION_INTERVAL_MS -
            performance.now();
      if (wait <= 0 && timer === undefined) {
        deliver(report);
        return;
      }
      pending = report;
      timer ??= setTimeout(flush, Math.max(0, wait));
    },
    close(): void {
      closed = true;
      pending = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  });
}
