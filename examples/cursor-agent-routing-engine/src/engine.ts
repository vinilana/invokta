import { createEngine } from "@ai-engine/core";

import { createRouteCursorTask } from "./capabilities/route-cursor-task.js";

export function createCursorAgentRoutingEngine() {
  return createEngine({
    name: "cursor-agent-routing-engine",
    version: "0.1.0",
    capabilities: {
      "developer-work.route-cursor-task": createRouteCursorTask(),
    },
  });
}

export const engine = createCursorAgentRoutingEngine();
