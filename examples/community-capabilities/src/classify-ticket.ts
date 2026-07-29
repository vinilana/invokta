import { defineExportedCapability } from "@invokta/core";

import type { ClassifyTicketDependencies } from "./application/ports.js";
import { createClassifyTicket } from "./capabilities/classify-ticket.js";

/**
 * A subpath export publishes one atomic capability on its own. Nothing here
 * reaches the library bundle, so importing this module never evaluates it
 * (`AE-LIB-06`).
 */
export function createClassifyTicketExport(
  dependencies: ClassifyTicketDependencies,
) {
  return defineExportedCapability({
    source: {
      name: "@invokta/example-community-capabilities/classify-ticket",
      version: "1.4.0",
    },
    defaultId: "community.classify-ticket",
    capability: createClassifyTicket(dependencies),
  });
}
