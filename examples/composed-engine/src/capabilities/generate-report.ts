import { defineCapability } from "@invokta/core";
import { z } from "zod";

import type { ReportSource } from "../application/ports.js";

const input = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

const output = z.object({
  day: z.string().min(1),
  openTickets: z.number().int().min(0),
  resolvedTickets: z.number().int().min(0),
  headline: z.string().min(1),
});

export function createGenerateReport(reports: ReportSource) {
  return defineCapability({
    title: "Generate report",
    description: "Generate the daily operations report for one day.",
    input,
    output,
    access: "authenticated",
    timeoutMs: 20_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    async run({ input: executionInput, context }) {
      return reports.summarize(executionInput.day, { signal: context.signal });
    },
  });
}
