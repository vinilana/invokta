/**
 * A valid composition published under a name other than `capabilities`, so the
 * same module covers both `--export <name>` selection and the missing-export
 * failure when the default name is requested.
 */
import {
  composeCapabilities,
  defineCapability,
  defineExportedCapability,
  importCapability,
} from "@invokta/core";

import { capability } from "./support.js";

const summarize = defineExportedCapability({
  source: { name: "@community/support-capabilities", version: "2.1.0" },
  defaultId: "support.summarize",
  capability: defineCapability(capability()),
});

export const engineCapabilities = composeCapabilities({
  local: { "app.health": defineCapability(capability()) },
  imports: [importCapability(summarize)],
});
