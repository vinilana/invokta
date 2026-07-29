export const MAX_SESSION_TASKS = 256;
export const MAX_SESSION_EVENTS = 10_000;
export const MAX_RESUME_TASKS = 20;
export const MAX_RESUME_CONTEXT_CHARACTERS = 16_000;

export type AgentHarness = "cursor" | "antigravity" | "claude-code" | "codex";

export type SessionPhase =
  | "discovery"
  | "planning"
  | "implementation"
  | "validation"
  | "delivery";

export type SessionStatus = "active" | "paused" | "completed";
export type AgentTaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed";

export interface TaskOwner {
  readonly harness: AgentHarness;
  readonly agentId: string;
}

export interface AgentTask {
  readonly id: string;
  readonly title: string;
  readonly phase: SessionPhase;
  readonly status: AgentTaskStatus;
  readonly owner: TaskOwner | null;
  readonly checkpoint: string | null;
  readonly evidence: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HarnessSession {
  readonly harness: AgentHarness;
  readonly nativeSessionId: string;
}

export interface AgentHookEvent {
  readonly id: string;
  readonly harness: AgentHarness;
  readonly nativeSessionId: string;
  readonly eventName: string;
  readonly observedAt: string;
  readonly toolName: string | null;
  readonly nativeAgentId: string | null;
  readonly nativeTaskId: string | null;
  readonly outcome: string | null;
  readonly payloadSha256: string;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly objective: string;
  readonly workspaceRoot: string;
  readonly phase: SessionPhase;
  readonly status: SessionStatus;
  readonly checkpoint: string | null;
  readonly nextAction: string | null;
  readonly revision: number;
  readonly tasks: ReadonlyArray<AgentTask>;
  readonly harnessSessions: ReadonlyArray<HarnessSession>;
  readonly events: ReadonlyArray<AgentHookEvent>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createAgentSession(input: {
  readonly sessionId: string;
  readonly objective: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
}): AgentSession {
  return {
    sessionId: input.sessionId,
    objective: input.objective,
    workspaceRoot: input.workspaceRoot,
    phase: "discovery",
    status: "active",
    checkpoint: null,
    nextAction: null,
    revision: 1,
    tasks: [],
    harnessSessions: [],
    events: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function buildResumeContext(session: AgentSession): string {
  const actionableTasks = session.tasks.filter(
    ({ status }) => status !== "completed",
  );
  const shownTasks = actionableTasks.slice(0, MAX_RESUME_TASKS);
  const lines = [
    `Portable agent session: ${session.sessionId}`,
    `Objective: ${session.objective}`,
    `Phase: ${session.phase}`,
    `Status: ${session.status}`,
    `Workspace: ${session.workspaceRoot}`,
    `Checkpoint: ${session.checkpoint ?? "None recorded."}`,
    `Next action: ${session.nextAction ?? "None recorded."}`,
    "Open tasks:",
    ...shownTasks.map((task) => {
      const owner =
        task.owner === null
          ? "unassigned"
          : `${task.owner.harness}/${task.owner.agentId}`;
      return `- ${task.id} [${task.status}, ${task.phase}, ${owner}]: ${task.title}${
        task.checkpoint === null ? "" : ` — ${task.checkpoint}`
      }`;
    }),
  ];
  if (shownTasks.length === 0) lines.push("- None.");
  if (actionableTasks.length > shownTasks.length) {
    lines.push(
      `- ${String(actionableTasks.length - shownTasks.length)} additional task(s) omitted; call agent-session.get for the complete state.`,
    );
  }
  const context = lines.join("\n");
  if (context.length <= MAX_RESUME_CONTEXT_CHARACTERS) return context;

  const notice =
    "\n- Resume context truncated; call agent-session.get for the complete state.";
  const prefixLimit = MAX_RESUME_CONTEXT_CHARACTERS - notice.length - 1;
  let prefix = context.slice(0, prefixLimit);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}…${notice}`;
}
