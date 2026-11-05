import { createEngine, defineCapability } from "@invokta/core";
import { z } from "zod";

const classify = defineCapability({
  title: "Classify ticket",
  description: "Classifies a support ticket.",
  input: z.object({
    ticketId: z.string().min(1),
    priority: z.enum(["low", "high"]).optional(),
  }),
  output: z.object({ category: z.string() }),
  access: "authenticated",
  timeoutMs: 5_000,
  annotations: { readOnly: true, idempotent: true },
  deprecated: {
    reason: "Superseded by the triage flow.",
    since: "2.0.0",
    replacement: "support.triage",
  },
  async run() {
    return { category: "billing" };
  },
});

const triage = defineCapability({
  description: "Routes a support ticket to a queue.",
  input: z.object({ ticketId: z.string().min(1) }),
  output: z.object({ queue: z.string() }),
  access: () => true,
  async run() {
    return { queue: "tier-1" };
  },
});

export const engine = createEngine({
  name: "contract-engine",
  version: "2.0.0",
  capabilities: {
    "support.triage": triage,
    "support.classify": classify,
  },
});

export const reorderedEngine = createEngine({
  name: "contract-engine",
  version: "2.0.0",
  capabilities: {
    "support.classify": classify,
    "support.triage": triage,
  },
});
