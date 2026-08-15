import { pretty } from "./dom.js";
import { exampleFromSchema } from "./example-from-schema.js";

export type CliJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CliJsonValue[]
  | { readonly [key: string]: CliJsonValue };

export interface CliTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CliCapabilitySummary {
  readonly id: string;
  readonly description: string;
  readonly title?: string;
  readonly annotations?: Readonly<Record<string, CliJsonValue>>;
}

export interface CliCapabilityDescription extends CliCapabilitySummary {
  readonly inputSchema: Readonly<Record<string, CliJsonValue>>;
  readonly outputSchema: Readonly<Record<string, CliJsonValue>>;
  readonly timeoutMs?: number;
}

export interface CliConnectionSummary {
  readonly command: string;
  readonly capabilityCount: number;
}

export type CliConnectionState =
  | {
      readonly state: "idle";
      readonly validation?: {
        readonly status: "error";
        readonly error: { readonly code: string; readonly message: string };
      };
      readonly activity?: readonly CliActivityRecord[];
    }
  | { readonly state: "busy" | "connecting" | "closing" }
  | {
      readonly state: "connected";
      readonly connection?: CliConnectionSummary;
    };

export type CliSession = CliConnectionState & {
  readonly csrfToken: string;
};

export interface CliActivityRecord {
  readonly sequence: number | string;
  readonly operation: "list" | "describe" | "run" | "disconnect";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: string;
  readonly errorCode?: string;
  readonly capabilityId?: string;
  readonly exitCode?: number | null;
}

export interface CliApi {
  session(): Promise<CliSession>;
  connect(target: CliTarget): Promise<CliConnectionState>;
  disconnect(): Promise<CliConnectionState>;
  refresh(): Promise<CliConnectionState>;
  catalog(): Promise<readonly CliCapabilitySummary[]>;
  describe(id: string): Promise<CliCapabilityDescription>;
  run(id: string, input: CliJsonValue): Promise<CliJsonValue>;
  activity(): Promise<readonly CliActivityRecord[]>;
}

export interface CliTargetDraft {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: readonly Readonly<{
    name: string;
    value: string;
  }>[];
}

export interface SecretControl {
  value: string;
  placeholder?: string;
}

export type RovingOrientation = "horizontal" | "vertical" | "both";
export type TargetDraftField =
  | "command"
  | "environment-name"
  | "environment-value";

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class TargetDraftValidationError extends Error {
  readonly field: TargetDraftField;
  readonly index: number | undefined;

  constructor(field: TargetDraftField, message: string, index?: number) {
    super(message);
    this.name = "TargetDraftValidationError";
    this.field = field;
    this.index = index;
  }
}

export function nextRovingIndex(
  current: number,
  itemCount: number,
  key: string,
  orientation: RovingOrientation,
): number | undefined {
  if (itemCount <= 0 || current < 0 || current >= itemCount) return undefined;
  let next = current;
  if (
    (orientation === "horizontal" || orientation === "both") &&
    key === "ArrowRight"
  ) {
    next += 1;
  } else if (
    (orientation === "horizontal" || orientation === "both") &&
    key === "ArrowLeft"
  ) {
    next -= 1;
  } else if (
    (orientation === "vertical" || orientation === "both") &&
    key === "ArrowDown"
  ) {
    next += 1;
  } else if (
    (orientation === "vertical" || orientation === "both") &&
    key === "ArrowUp"
  ) {
    next -= 1;
  } else if (key === "Home") {
    return 0;
  } else if (key === "End") {
    return itemCount - 1;
  } else {
    return undefined;
  }
  return (next + itemCount) % itemCount;
}

function nonEmpty(value: string, message: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new TargetDraftValidationError("command", message);
  }
  return normalized;
}

export function buildCliTarget(draft: CliTargetDraft): CliTarget {
  const command = nonEmpty(draft.command, "Command is required.");
  const cwd = draft.cwd?.trim();
  const env = Object.create(null) as Record<string, string>;

  for (const [index, entry] of draft.environment.entries()) {
    const name = entry.name.trim();
    if (!environmentNamePattern.test(name)) {
      throw new TargetDraftValidationError(
        "environment-name",
        "Environment names must use letters, numbers, and underscores.",
        index,
      );
    }
    if (Object.hasOwn(env, name)) {
      throw new TargetDraftValidationError(
        "environment-name",
        "Environment names must be unique.",
        index,
      );
    }
    if (entry.value === "") {
      throw new TargetDraftValidationError(
        "environment-value",
        "Environment values cannot be empty.",
        index,
      );
    }
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      value: entry.value,
      writable: true,
    });
  }

  return {
    command,
    args: [...draft.args],
    ...(cwd === undefined || cwd === "" ? {} : { cwd }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
  };
}

export function clearCliSecrets(controls: readonly SecretControl[]): void {
  for (const control of controls) {
    control.value = "";
    control.placeholder = "Cleared after response";
  }
}

export async function completeConnectionAttempt<Value>(
  attempt: Promise<Value>,
  secretControls: readonly SecretControl[],
): Promise<Value> {
  try {
    return await attempt;
  } finally {
    clearCliSecrets(secretControls);
  }
}

export function seedCliInput(
  schema: Readonly<Record<string, CliJsonValue>>,
): string {
  const example = exampleFromSchema(schema);
  if (
    typeof example !== "object" ||
    example === null ||
    Array.isArray(example)
  ) {
    return "{}";
  }
  return pretty(example);
}

export function parseRunInput(
  source: string,
): Readonly<Record<string, CliJsonValue>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Run input must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Run input must be a JSON object.");
  }
  return parsed as Readonly<Record<string, CliJsonValue>>;
}

export function retainedActivityOf(
  state: CliConnectionState,
): readonly CliActivityRecord[] {
  if (state.state !== "idle") return [];
  return Array.isArray(state.activity) ? state.activity : [];
}

/** Refresh is another `list`. Any list failure except busy disconnects. */
export function refreshFailureIsDisconnect(code: string | undefined): boolean {
  return code !== "TARGET_BUSY";
}
