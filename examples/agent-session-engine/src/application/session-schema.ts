import { z } from "zod";

import { MAX_RESUME_CONTEXT_CHARACTERS } from "../domain/agent-session.js";

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, {
    message:
      "An identifier may contain only letters, digits, dot, underscore, colon, and hyphen.",
  });

export const harnessSchema = z.enum([
  "cursor",
  "antigravity",
  "claude-code",
  "codex",
]);

export const phaseSchema = z.enum([
  "discovery",
  "planning",
  "implementation",
  "validation",
  "delivery",
]);

export const sessionStatusSchema = z.enum(["active", "paused", "completed"]);
export const taskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "completed",
]);

export const taskOwnerSchema = z.object({
  harness: harnessSchema,
  agentId: identifierSchema,
});

export const agentTaskSchema = z.object({
  id: identifierSchema,
  title: z.string().trim().min(1).max(200),
  phase: phaseSchema,
  status: taskStatusSchema,
  owner: taskOwnerSchema.nullable(),
  checkpoint: z.string().max(4_000).nullable(),
  evidence: z.string().max(4_000).nullable(),
  revision: z.number().int().min(1),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
});

export const harnessSessionSchema = z.object({
  harness: harnessSchema,
  nativeSessionId: z.string().trim().min(1).max(256),
});

export const agentHookEventSchema = z.object({
  id: identifierSchema,
  harness: harnessSchema,
  nativeSessionId: z.string().trim().min(1).max(256),
  eventName: z.string().trim().min(1).max(128),
  observedAt: z.string().min(1).max(64),
  toolName: z.string().trim().min(1).max(256).nullable(),
  nativeAgentId: z.string().trim().min(1).max(256).nullable(),
  nativeTaskId: z.string().trim().min(1).max(256).nullable(),
  outcome: z.string().trim().min(1).max(128).nullable(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const agentSessionSchema = z.object({
  sessionId: identifierSchema,
  objective: z.string().trim().min(1).max(2_000),
  workspaceRoot: z.string().trim().min(1).max(2_000),
  phase: phaseSchema,
  status: sessionStatusSchema,
  checkpoint: z.string().max(4_000).nullable(),
  nextAction: z.string().max(4_000).nullable(),
  revision: z.number().int().min(1),
  tasks: z.array(agentTaskSchema).max(256),
  harnessSessions: z.array(harnessSessionSchema).max(64),
  events: z.array(agentHookEventSchema).max(10_000),
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
});

export const sessionViewSchema = agentSessionSchema.extend({
  eventCount: z.number().int().min(0).max(10_000),
  resumeContext: z.string().min(1).max(MAX_RESUME_CONTEXT_CHARACTERS),
});
