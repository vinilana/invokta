export type UnknownRecord = Readonly<Record<string, unknown>>;

export const programName = "invokta-devtools";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Every value in a diagnostic is emitted as a JSON string literal. Engine
 * names, capability IDs, and error messages are author-controlled, so quoting
 * keeps a crafted value from forging an additional diagnostic line and keeps
 * the output byte-stable for grepping.
 */
export function quote(value: string): string {
  return JSON.stringify(value);
}

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as UnknownRecord;
}

export function token(value: unknown): string {
  return typeof value === "string" ? quote(value) : '"<unreadable>"';
}

export function renderLines(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

/**
 * Describes a thrown value without echoing a stack, cause, or payload. Only
 * the error name, code, and message are actionable at this boundary.
 */
export function describeThrownValue(error: unknown): string {
  try {
    if (typeof error === "string") {
      return `error: message=${quote(error)}`;
    }
    const record = asRecord(error);
    if (record === undefined) return 'error: name="<unreadable>"';
    const name = record.name;
    const code = record.code;
    const message = record.message;
    const parts = [`error: name=${token(name)}`];
    if (typeof code === "string") parts.push(`code=${quote(code)}`);
    parts.push(`message=${token(message)}`);
    return parts.join(" ");
  } catch {
    return 'error: name="<unreadable>"';
  }
}
