/**
 * The pre-flattened object-spread case from `AE-COLLISION-06`.
 *
 * The spread silently keeps the last `tickets.classify` declaration, so the
 * collision is already lost before any framework code can observe it. The
 * checker must reject this map instead of reporting a valid composition.
 */
import { defineCapability } from "@ai-engine/core";

import { capability } from "./support.js";

const first = {
  "tickets.classify": defineCapability(capability()),
  "tickets.route": defineCapability(capability()),
};

const second = {
  "tickets.classify": defineCapability(capability()),
};

export const capabilities = { ...first, ...second };
