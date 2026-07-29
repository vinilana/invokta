import { createHash, randomUUID } from "node:crypto";

import { runCli } from "@invokta/cli";
import type { Principal } from "@invokta/core";

import type { AgentHarness } from "../domain/agent-session.js";
import type { createAgentSessionEngine } from "../engine.js";

type AgentSessionEngine = ReturnType<typeof createAgentSessionEngine>;
type JsonRecord = Record<string, unknown>;

export interface NormalizeHookEventOptions {
  readonly portableSessionId?: string;
  readonly eventName?: string;
  readonly observedAt: string;
  readonly cwd?: string;
}

export interface NormalizedHookEvent {
  readonly sessionId: string;
  readonly harness: AgentHarness;
  readonly nativeSessionId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly observedAt: string;
  readonly workspaceRoot: string;
  readonly toolName: string | null;
  readonly nativeAgentId: string | null;
  readonly nativeTaskId: string | null;
  readonly outcome: string | null;
  readonly payloadSha256: string;
}

export interface RunHookCommandOptions {
  readonly rawInput: string;
  readonly portableSessionId?: string;
  readonly eventName?: string;
  readonly observedAt: string;
  readonly cwd?: string;
  readonly engine: AgentSessionEngine;
  readonly principal: Principal;
  readonly writeStdout: (text: string) => void | Promise<void>;
  readonly writeStderr: (text: string) => void | Promise<void>;
}

interface RecordHookResult {
  readonly recorded: boolean;
  readonly resumed: boolean;
  readonly resumeContext: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function firstString(
  object: JsonRecord,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function firstNumber(
  object: JsonRecord,
  keys: ReadonlyArray<string>,
): number | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function firstWorkspace(object: JsonRecord, fallback: string): string {
  for (const key of ["workspace_roots", "workspacePaths"]) {
    const value = object[key];
    if (Array.isArray(value)) {
      const first = value.find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.trim() !== "",
      );
      if (first !== undefined) return first.trim().slice(0, 2_000);
    }
  }
  return (
    firstString(object, ["cwd", "workspace_root", "workspaceRoot"]) ?? fallback
  ).slice(0, 2_000);
}

function bounded(value: string | null, maximum: number): string | null {
  return value === null ? null : value.slice(0, maximum);
}

const knownOutcomes: ReadonlySet<string> = new Set([
  "startup",
  "resume",
  "clear",
  "compact",
  "manual",
  "auto",
  "completed",
  "aborted",
  "success",
  "failure",
  "error",
  "other",
  "logout",
  "prompt_input_exit",
  "bypass_permissions_disabled",
  "model_stop",
  "max_steps_exceeded",
  "rate_limit",
  "authentication_failed",
  "billing_error",
  "invalid_request",
  "server_error",
  "max_output_tokens",
]);

function payloadOutcome(object: JsonRecord): string | null {
  const error = object.error;
  if (typeof error === "string" && error !== "") return "error";
  const candidate = firstString(object, [
    "source",
    "reason",
    "status",
    "terminationReason",
    "termination_reason",
  ]);
  return candidate === null
    ? null
    : knownOutcomes.has(candidate)
      ? candidate
      : "other";
}

function defaultPortableSessionId(
  harness: AgentHarness,
  nativeSessionId: string,
): string {
  const component = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(nativeSessionId)
    ? nativeSessionId
    : createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 32);
  return `${harness}:${component}`;
}

export function normalizeHookEvent(
  harness: AgentHarness,
  rawInput: string,
  options: NormalizeHookEventOptions,
): NormalizedHookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput) as unknown;
  } catch (cause) {
    throw new Error("Hook input must be valid JSON.", { cause });
  }
  const input = asRecord(parsed);
  if (input === null) throw new Error("Hook input must be a JSON object.");

  const payloadSha256 = createHash("sha256").update(rawInput).digest("hex");
  const nativeSessionId = bounded(
    firstString(input, ["session_id", "conversation_id", "conversationId"]),
    256,
  );
  const resolvedNativeSessionId = nativeSessionId ?? "unavailable";
  const eventName = bounded(
    options.eventName ??
      firstString(input, ["hook_event_name", "hookEventName"]) ??
      "unknown",
    128,
  ) as string;
  const toolCall = asRecord(input.toolCall);
  const toolName = bounded(
    firstString(input, ["tool_name", "toolName"]) ??
      (toolCall === null ? null : firstString(toolCall, ["name"])),
    256,
  );
  const occurrence = [
    firstString(input, [
      "tool_use_id",
      "generation_id",
      "turn_id",
      "task_id",
      "agent_id",
    ]),
    firstNumber(input, ["stepIdx", "invocationNum", "executionNum"]),
  ]
    .filter((value) => value !== null)
    .join(":");
  const eventDigest = createHash("sha256")
    .update(
      [
        harness,
        resolvedNativeSessionId,
        eventName,
        occurrence === ""
          ? `delivery:${randomUUID()}`
          : `occurrence:${occurrence}`,
        payloadSha256,
      ].join("\0"),
    )
    .digest("hex");

  return {
    sessionId:
      options.portableSessionId ??
      defaultPortableSessionId(harness, resolvedNativeSessionId),
    harness,
    nativeSessionId: resolvedNativeSessionId,
    eventId: `evt_${eventDigest.slice(0, 32)}`,
    eventName,
    observedAt: options.observedAt,
    workspaceRoot: firstWorkspace(input, options.cwd ?? process.cwd()),
    toolName,
    nativeAgentId: bounded(
      firstString(input, ["agent_id", "teammate_name", "teammateName"]),
      256,
    ),
    nativeTaskId: bounded(firstString(input, ["task_id", "taskId"]), 256),
    outcome: payloadOutcome(input),
    payloadSha256,
  };
}

function parseRecordHookResult(encoded: string): RecordHookResult {
  const parsed = JSON.parse(encoded) as unknown;
  const result = asRecord(parsed);
  if (
    result === null ||
    typeof result.recorded !== "boolean" ||
    typeof result.resumed !== "boolean" ||
    typeof result.resumeContext !== "string" ||
    typeof result.sessionId !== "string" ||
    typeof result.sessionRevision !== "number"
  ) {
    throw new Error("The hook capability returned an invalid result.");
  }
  return {
    recorded: result.recorded,
    resumed: result.resumed,
    resumeContext: result.resumeContext,
    sessionId: result.sessionId,
    sessionRevision: result.sessionRevision,
  };
}

function hookOutput(
  harness: AgentHarness,
  eventName: string,
  input: JsonRecord,
  result: RecordHookResult,
): JsonRecord {
  const resumeContext = result.resumed ? result.resumeContext : null;
  if (
    (harness === "codex" || harness === "claude-code") &&
    eventName === "SessionStart" &&
    resumeContext !== null
  ) {
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: resumeContext,
      },
    };
  }
  if (
    harness === "cursor" &&
    eventName === "sessionStart" &&
    resumeContext !== null
  ) {
    return { additional_context: resumeContext };
  }
  if (harness === "antigravity") {
    if (eventName === "PreInvocation") {
      const invocationNumber = input.invocationNum;
      return {
        injectSteps:
          invocationNumber === 0 && resumeContext !== null
            ? [{ ephemeralMessage: resumeContext }]
            : [],
      };
    }
    if (eventName === "PostInvocation") {
      return { injectSteps: [], terminationBehavior: "" };
    }
    if (eventName === "Stop") return { decision: "stop" };
  }
  return {};
}

export async function runHookCommand(
  harness: AgentHarness,
  options: RunHookCommandOptions,
): Promise<number> {
  const normalized = normalizeHookEvent(harness, options.rawInput, {
    ...(options.portableSessionId === undefined
      ? {}
      : { portableSessionId: options.portableSessionId }),
    ...(options.eventName === undefined
      ? {}
      : { eventName: options.eventName }),
    observedAt: options.observedAt,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  let capabilityOutput = "";
  const code = await runCli(options.engine, {
    argv: [
      "run",
      "agent-session.record-hook-event",
      "--input",
      JSON.stringify(normalized),
    ],
    principal: options.principal,
    io: {
      readStdin: async () => "",
      writeStdout: (text) => {
        capabilityOutput += text;
      },
      writeStderr: options.writeStderr,
    },
  });
  if (code !== 0) return code;

  const rawParsed = JSON.parse(options.rawInput) as unknown;
  const input = asRecord(rawParsed);
  if (input === null) throw new Error("Hook input must be a JSON object.");
  const result = parseRecordHookResult(capabilityOutput);
  await options.writeStdout(
    JSON.stringify(hookOutput(harness, normalized.eventName, input, result)),
  );
  return 0;
}
