import {
  composeCapabilities,
  defineCapability,
  defineCapabilityLibrary,
  defineExportedCapability,
  importCapabilities,
  importCapability,
} from "@ai-engine/core";

import { capability } from "./support.js";

const summarize = defineExportedCapability({
  source: { name: "@community/support-capabilities", version: "2.1.0" },
  defaultId: "support.summarize",
  capability: defineCapability(capability()),
});

const tickets = defineCapabilityLibrary({
  name: "@community/tickets",
  version: "3.0.0",
  capabilities: {
    "tickets.classify": defineCapability(capability()),
    "tickets.route": defineCapability(capability()),
  },
});

export const capabilities = composeCapabilities({
  local: { "app.health": defineCapability(capability()) },
  imports: [
    importCapability(summarize),
    importCapabilities(tickets, {
      include: ["tickets.classify"],
      remap: { "tickets.classify": "app.classify" },
    }),
  ],
});
