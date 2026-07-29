export const cursorUseCases = [
  "plan",
  "review",
  "complex-development",
  "debug",
  "documentation",
  "prototype-development",
  "simple-development",
] as const;

export type CursorUseCase = (typeof cursorUseCases)[number];

export interface CursorModelSelection {
  readonly displayName: string;
  readonly selector: string;
}

export interface CursorAgentRoute {
  readonly catalogDate: "2026-07-28";
  readonly useCase: CursorUseCase;
  readonly agent: {
    readonly name: string;
    readonly invocation: string;
    readonly readOnly: boolean;
  };
  readonly primaryModel: CursorModelSelection;
  readonly fallbackModel: CursorModelSelection;
  readonly rationale: string;
  readonly instructions: string;
}

type RouteDefinition = Omit<CursorAgentRoute, "catalogDate" | "useCase">;

const routes = {
  plan: {
    agent: { name: "planner", invocation: "/planner", readOnly: true },
    primaryModel: {
      displayName: "Claude Opus 5",
      selector: "claude-opus-5",
    },
    fallbackModel: {
      displayName: "GPT-5.6 Sol",
      selector: "gpt-5.6-sol",
    },
    rationale:
      "Use the newest high-context Opus model for dependency analysis, ambiguity resolution, and high-consequence planning.",
    instructions:
      "Inspect requirements and constraints, produce a dependency-aware plan with validation steps, and do not edit files.",
  },
  review: {
    agent: { name: "reviewer", invocation: "/reviewer", readOnly: true },
    primaryModel: {
      displayName: "Claude Fable 5",
      selector: "claude-fable-5",
    },
    fallbackModel: {
      displayName: "Claude Opus 5",
      selector: "claude-opus-5",
    },
    rationale:
      "Use the strongest current CursorBench model to trace behavior across the diff and surface subtle correctness risks.",
    instructions:
      "Review without editing, report actionable findings first, and cite each finding with file and line evidence.",
  },
  "complex-development": {
    agent: {
      name: "complex-builder",
      invocation: "/complex-builder",
      readOnly: false,
    },
    primaryModel: {
      displayName: "Grok 4.5",
      selector: "grok-4.5",
    },
    fallbackModel: {
      displayName: "GPT-5.6 Sol",
      selector: "gpt-5.6-sol",
    },
    rationale:
      "Use Cursor's long-horizon model for multi-file work that requires sustained tool use, recovery, and verification.",
    instructions:
      "Own the complete multi-file implementation, preserve architectural boundaries, and keep iterating until focused and full validation pass.",
  },
  debug: {
    agent: { name: "debugger", invocation: "/debugger", readOnly: false },
    primaryModel: {
      displayName: "GPT-5.6 Sol",
      selector: "gpt-5.6-sol",
    },
    fallbackModel: {
      displayName: "Claude Fable 5",
      selector: "claude-fable-5",
    },
    rationale:
      "Use a frontier reasoning model with strong agentic coding performance for diagnosis, terminal work, and verified repairs.",
    instructions:
      "Reproduce the failure, isolate the root cause, add a regression test, implement the smallest repair, and rerun the relevant suite.",
  },
  documentation: {
    agent: {
      name: "documenter",
      invocation: "/documenter",
      readOnly: false,
    },
    primaryModel: {
      displayName: "Gemini 3.6 Flash",
      selector: "gemini-3.6-flash",
    },
    fallbackModel: {
      displayName: "Composer 2.5",
      selector: "composer-2.5",
    },
    rationale:
      "Use a careful, broad-context model to reconcile implementation, contracts, examples, and reader-facing explanations.",
    instructions:
      "Read the authoritative code and contracts, update only documentation, keep examples executable, and avoid unsupported claims.",
  },
  "prototype-development": {
    agent: {
      name: "prototyper",
      invocation: "/prototyper",
      readOnly: false,
    },
    primaryModel: {
      displayName: "Composer 2.5 Fast",
      selector: "composer-2.5-fast",
    },
    fallbackModel: {
      displayName: "GPT-5.6 Luna",
      selector: "gpt-5.6-luna",
    },
    rationale:
      "Use Cursor's fast agentic coding model for short feedback loops and inexpensive exploratory implementation.",
    instructions:
      "Build the smallest runnable spike that tests the central assumption, label shortcuts explicitly, and record what must change before production.",
  },
  "simple-development": {
    agent: {
      name: "simple-builder",
      invocation: "/simple-builder",
      readOnly: false,
    },
    primaryModel: {
      displayName: "GPT-5.6 Luna",
      selector: "gpt-5.6-luna",
    },
    fallbackModel: {
      displayName: "Composer 2.5 Fast",
      selector: "composer-2.5-fast",
    },
    rationale:
      "Use the lightweight GPT-5.6 tier for narrow, well-specified changes where latency and cost matter most.",
    instructions:
      "Make the narrow requested change, avoid adjacent refactors, and run the smallest validation command that proves it.",
  },
} as const satisfies Readonly<Record<CursorUseCase, RouteDefinition>>;

export function routeCursorTask(useCase: CursorUseCase): CursorAgentRoute {
  const route = routes[useCase];
  return {
    catalogDate: "2026-07-28",
    useCase,
    agent: { ...route.agent },
    primaryModel: { ...route.primaryModel },
    fallbackModel: { ...route.fallbackModel },
    rationale: route.rationale,
    instructions: route.instructions,
  };
}
