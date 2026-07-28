import { createEngine } from "@ai-engine/core";

import type { OperationsDependencies } from "./application/ports.js";
import { capabilities, createOperationsCapabilities } from "./capabilities.js";

const name = "composed-engine";
const version = "0.1.0";

export function createOperationsEngine(dependencies: OperationsDependencies) {
  return createEngine({
    name,
    version,
    capabilities: createOperationsCapabilities(dependencies),
  });
}

export const engine = createEngine({ name, version, capabilities });
