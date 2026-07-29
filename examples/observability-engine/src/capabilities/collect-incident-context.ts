import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type { ObservabilityDependencies } from "../application/ports.js";

const maximumWindowMs = 7 * 24 * 60 * 60 * 1_000;

const inputSchema = z
  .object({
    service: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .superRefine(({ from, to }, context) => {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (fromMs >= toMs) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "The end of the window must be after its start.",
      });
      return;
    }
    if (toMs - fromMs > maximumWindowMs) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "The time window cannot exceed seven days.",
      });
    }
  });

const issueSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  project: z.string().min(1),
  lastSeen: z.iso.datetime({ offset: true }),
  eventCount: z.number().int().nonnegative(),
  url: z.string().url().nullable(),
});

const logSchema = z.object({
  id: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
  service: z.string().min(1),
  severity: z.string().min(1).nullable(),
  message: z.string(),
});

const telemetrySchema = z.object({
  transactionCount: z.number().int().nonnegative(),
  errorRate: z.number().min(0).max(100),
  averageDurationMs: z.number().nonnegative().nullable(),
});

const outputSchema = z.object({
  service: z.string().min(1),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  issues: z.array(issueSchema),
  logs: z.array(logSchema),
  telemetry: telemetrySchema,
});

export function createCollectIncidentContext({
  issues,
  logs,
  telemetry,
}: ObservabilityDependencies) {
  return defineCapability({
    title: "Collect incident context",
    description:
      "Collect bounded issue, log, and telemetry context for one service and time window.",
    input: inputSchema,
    output: outputSchema,
    access: "authenticated",
    timeoutMs: 30_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }): Promise<z.input<typeof outputSchema>> {
      const siblingController = new AbortController();
      const options = {
        signal: AbortSignal.any([context.signal, siblingController.signal]),
      };
      try {
        const [issueResults, logResults, telemetryResult] = await Promise.all([
          issues.searchServiceIssues(input, options),
          logs.searchServiceLogs(input, options),
          telemetry.summarizeService(input, options),
        ]);
        return {
          service: input.service,
          from: input.from,
          to: input.to,
          issues: issueResults.slice(0, input.limit),
          logs: logResults.slice(0, input.limit),
          telemetry: telemetryResult,
        };
      } catch (cause) {
        siblingController.abort(cause);
        throw cause;
      }
    },
  });
}
