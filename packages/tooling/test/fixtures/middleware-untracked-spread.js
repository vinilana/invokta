/**
 * Middleware applied to a pre-flattened object-spread map.
 *
 * Wrapping cannot recover the provenance the spread already discarded, so the
 * checker must keep rejecting the export as untracked.
 */
import { applyMiddleware, defineCapability } from "@invokta/core";

import { capability } from "./support.js";

const first = { "tickets.classify": defineCapability(capability()) };
const second = { "tickets.classify": defineCapability(capability()) };

export const capabilities = applyMiddleware(
  { ...first, ...second },
  async ({ next }) => next(),
);
