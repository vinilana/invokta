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
  /** Delivers the held report, if any, then closes the forwarder. */
  readonly finish: () => void;
  /** Drops the held report, if any, and closes the forwarder. */
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
 * Forwards accepted progress reports as notifications for one request.
 *
 * The forwarder holds at most one report. It sends a notification only when
 * the previous one has been written, the optional `canSend` gate reports
 * downstream capacity, and at least one interval has passed since the last
 * send. Otherwise the newest report replaces the held one and is retried at
 * the next interval, so a slow or stalled reader never accumulates more than
 * one unwritten notification and one held report. `finish` delivers the held
 * report once; `close` drops it. Send and gate failures are contained.
 */
export function createProgressForwarder(
  progressToken: McpProgressToken,
  send: (params: McpProgressNotificationParams) => Promise<void>,
  canSend: () => boolean = () => true,
): McpProgressForwarder {
  let closed = false;
  let writing = false;
  let lastSentAt: number | undefined;
  let held: ProgressReport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hasCapacity = (): boolean => {
    if (writing) return false;
    try {
      return canSend() === true;
    } catch {
      return false;
    }
  };
  const deliver = (report: ProgressReport): void => {
    lastSentAt = performance.now();
    writing = true;
    const written = (): void => {
      writing = false;
    };
    try {
      void send({
        progressToken,
        progress: report.progress,
        ...(report.total === undefined ? {} : { total: report.total }),
        ...(report.message === undefined ? {} : { message: report.message }),
      }).then(written, written);
    } catch {
      // A closed or failing transport cannot change the tool result.
      written();
    }
  };
  const retryAfter = (delayMs: number): void => {
    timer ??= setTimeout(retry, Math.max(0, delayMs));
  };
  function retry(): void {
    timer = undefined;
    if (closed || held === undefined) return;
    if (!hasCapacity()) {
      retryAfter(MIN_PROGRESS_NOTIFICATION_INTERVAL_MS);
      return;
    }
    const report = held;
    held = undefined;
    deliver(report);
  }
  const close = (): void => {
    closed = true;
    held = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
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
      if (wait <= 0 && timer === undefined && hasCapacity()) {
        deliver(report);
        return;
      }
      held = report;
      retryAfter(wait > 0 ? wait : MIN_PROGRESS_NOTIFICATION_INTERVAL_MS);
    },
    finish(): void {
      if (closed) return;
      const report = held;
      close();
      if (report !== undefined) deliver(report);
    },
    close,
  });
}
