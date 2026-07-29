import {
  composeCapabilities,
  importCapabilities,
  importCapability,
} from "@invokta/core";
import { createScoreTicketPriorityExport } from "@invokta/example-community-capabilities";
import { createClassifyTicketExport } from "@invokta/example-community-capabilities/classify-ticket";
import { createCommunitySupportLibrary } from "@invokta/example-community-capabilities/library";

import type { OperationsDependencies } from "./application/ports.js";
import { createGenerateReport } from "./capabilities/generate-report.js";
import { createDefaultOperationsDependencies } from "./infrastructure/default-dependencies.js";

/**
 * This module is the composition root the build gate inspects. It creates no
 * engine and starts no adapter, so `invokta check-capabilities` can import it
 * without running the application.
 */
export function createOperationsCapabilities(
  dependencies: OperationsDependencies,
) {
  return composeCapabilities({
    local: {
      "operations.generate-report": createGenerateReport(dependencies.reports),
    },
    imports: [
      importCapability(createScoreTicketPriorityExport(dependencies.community)),
      importCapability(createClassifyTicketExport(dependencies.community), {
        as: "operations.classify-ticket",
      }),
      importCapabilities(
        createCommunitySupportLibrary(dependencies.community),
        {
          include: ["community.search-knowledge-base", "community.draft-reply"],
          remap: { "community.draft-reply": "operations.draft-reply" },
        },
      ),
    ],
  });
}

export const capabilities = createOperationsCapabilities(
  createDefaultOperationsDependencies(),
);
