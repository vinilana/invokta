import type { ChildProcess } from "node:child_process";

export const ATTACHED_CLI_SESSION_LIMITS = Object.freeze({
  listTimeoutMs: 15_000,
  describeTimeoutMs: 15_000,
  runTimeoutMs: 60_000,
  streamBytes: 10 * 1024 * 1024,
  catalogSummaries: 2_000,
  inputArgumentBytes: 98_304,
  activityRecords: 500,
  retainedActivityRecords: 50,
  displayedNameCodePoints: 256,
});

export type AttachedCliSessionErrorCode =
  | "INVALID_TARGET"
  | "SPAWN_FAILED"
  | "CONNECTION_FAILED"
  | "PROTOCOL_ERROR"
  | "TIMEOUT"
  | "LIMIT_EXCEEDED"
  | "TARGET_BUSY"
  | "NOT_CONNECTED"
  | "ENVIRONMENT_VALUE_MISSING";

const errorMessages = {
  INVALID_TARGET: "The CLI target descriptor is invalid.",
  SPAWN_FAILED: "The CLI process could not be started.",
  CONNECTION_FAILED: "The CLI connection failed.",
  PROTOCOL_ERROR: "The CLI returned an invalid document.",
  TIMEOUT: "The CLI operation timed out.",
  LIMIT_EXCEEDED: "The CLI operation exceeded a configured limit.",
  TARGET_BUSY: "Another target or CLI verb is already active.",
  NOT_CONNECTED: "No CLI target is connected.",
  ENVIRONMENT_VALUE_MISSING: "A required environment value is missing.",
} as const satisfies Record<AttachedCliSessionErrorCode, string>;

export class AttachedCliSessionError extends Error {
  declare readonly code: AttachedCliSessionErrorCode;
  declare readonly message: string;

  constructor(code: AttachedCliSessionErrorCode, options?: ErrorOptions) {
    super();
    Object.defineProperties(this, {
      code: {
        configurable: false,
        enumerable: true,
        value: code,
        writable: false,
      },
      message: {
        configurable: false,
        enumerable: true,
        value: errorMessages[code],
        writable: false,
      },
      ...(options?.cause === undefined
        ? {}
        : {
            cause: {
              configurable: false,
              enumerable: false,
              value: options.cause,
              writable: false,
            },
          }),
    });
  }
}

export function attachedCliError(
  code: AttachedCliSessionErrorCode,
  cause?: unknown,
): AttachedCliSessionError {
  return new AttachedCliSessionError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

export interface AttachedCliAnnotations {
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly openWorld?: boolean;
}

export interface AttachedCliCapabilitySummary {
  readonly id: string;
  readonly description: string;
  readonly title?: string;
  readonly annotations?: AttachedCliAnnotations;
}

export interface AttachedCliCapabilityDescription
  extends AttachedCliCapabilitySummary {
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

export interface AttachedCliActivityRecord {
  readonly sequence: number;
  readonly operation: "list" | "describe" | "run" | "disconnect";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: "success" | "error";
  readonly errorCode?: AttachedCliSessionErrorCode;
  readonly capabilityId?: string;
  readonly exitCode?: number | null;
}

export interface AttachedCliConnectionSummary {
  readonly command: string;
  readonly capabilityCount: number;
  readonly validation: { readonly status: "ok" };
}

export type AttachedCliSessionState =
  | {
      readonly state: "idle";
      readonly validation?: {
        readonly status: "error";
        readonly error: {
          readonly code: AttachedCliSessionErrorCode;
          readonly message: string;
        };
      };
      readonly activity?: readonly AttachedCliActivityRecord[];
    }
  | { readonly state: "busy" }
  | { readonly state: "connecting" }
  | {
      readonly state: "connected";
      readonly connection: AttachedCliConnectionSummary;
    }
  | { readonly state: "closing" };

export interface AttachedCliSessionClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface AttachedCliSpawnOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export type AttachedCliSpawn = (
  command: string,
  args: readonly string[],
  options: AttachedCliSpawnOptions,
) => ChildProcess;

export interface CreateAttachedCliSessionControllerOptions {
  readonly spawn?: AttachedCliSpawn;
  readonly clock?: AttachedCliSessionClock;
  readonly killGraceMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly readHostEnv?: (name: string) => string | undefined;
}

export interface AttachedCliSessionController {
  connect(
    owner: string,
    target: unknown,
  ): Promise<AttachedCliConnectionSummary>;
  refresh(owner: string): Promise<AttachedCliConnectionSummary>;
  describe(
    owner: string,
    id: string,
  ): Promise<AttachedCliCapabilityDescription>;
  run(owner: string, id: string, input: unknown): Promise<unknown>;
  state(owner: string): AttachedCliSessionState;
  catalog(owner: string): readonly AttachedCliCapabilitySummary[];
  description(owner: string): AttachedCliCapabilityDescription | undefined;
  activity(owner: string): readonly AttachedCliActivityRecord[];
  disconnect(owner: string): Promise<void>;
  close(): Promise<void>;
}

export interface ParsedCliTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly overlay: Readonly<Record<string, string>>;
}

export interface AttachedCliChildResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}
