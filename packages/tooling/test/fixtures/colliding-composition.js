/**
 * A single composition that triggers every issue variant at once, so one run of
 * the checker has to report all of them.
 *
 * Expected issues:
 * - `app.classify`        local versus a remapped library capability
 * - `app.health`          local versus an atomic import remapped with `as`
 * - `support.summarize`   the same atomic export imported twice, proving that
 *                         composition performs no identity deduplication
 * - `CAPABILITY_IMPORT_INVALID`      a bare definition passed to importCapability
 * - `CAPABILITY_IMPORT_ID_NOT_FOUND` an include entry the library does not own
 * - `CAPABILITY_REMAP_NOT_SELECTED`  a remap key that was never selected
 */
import {
  composeCapabilities,
  defineCapability,
  defineCapabilityLibrary,
  defineExportedCapability,
  importCapabilities,
  importCapability,
} from "@invokta/core";

import { capability } from "./support.js";

const summarize = defineExportedCapability({
  source: { name: "@community/support-capabilities", version: "2.1.0" },
  defaultId: "support.summarize",
  capability: defineCapability(capability()),
});

// Declared without a version so the atomic provenance renders both variants.
const probe = defineExportedCapability({
  source: { name: "@community/probes" },
  defaultId: "probe.health",
  capability: defineCapability(capability()),
});

const tickets = defineCapabilityLibrary({
  name: "@community/tickets",
  version: "3.0.0",
  capabilities: {
    "tickets.classify": defineCapability(capability()),
    "tickets.route": defineCapability(capability()),
    "tickets.summarize": defineCapability(capability()),
  },
});

export const capabilities = composeCapabilities({
  local: {
    "app.health": defineCapability(capability()),
    "app.classify": defineCapability(capability()),
  },
  imports: [
    importCapability(summarize),
    importCapability(summarize, { as: "support.summarize" }),
    importCapability(probe, { as: "app.health" }),
    importCapability(defineCapability(capability())),
    importCapabilities(tickets, {
      include: ["tickets.classify", "tickets.route", "tickets.unknown"],
      remap: {
        "tickets.classify": "app.classify",
        "tickets.summarize": "app.summarize",
      },
    }),
  ],
});
