import type { CommunitySupportDependencies } from "@ai-engine/example-community-capabilities";

import type { OperationsReport } from "../domain/report.js";

export interface ReportSource {
  summarize(
    day: string,
    options: { readonly signal: AbortSignal },
  ): Promise<OperationsReport>;
}

/**
 * The engine owns every port the imported capabilities need. The community
 * package declares the interfaces; this application decides what implements
 * them.
 */
export interface OperationsDependencies {
  readonly community: CommunitySupportDependencies;
  readonly reports: ReportSource;
}
