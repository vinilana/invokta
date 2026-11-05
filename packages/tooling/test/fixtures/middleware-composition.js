/**
 * A tracked composition wrapped with capability middleware.
 *
 * `applyMiddleware` keeps the composed map's keys one-to-one, so the wrapped
 * export must still pass the check as a tracked composition.
 */
import {
  applyMiddleware,
  composeCapabilities,
  defineCapability,
  defineCapabilityLibrary,
  importCapabilities,
} from "@invokta/core";

import { capability } from "./support.js";

const tickets = defineCapabilityLibrary({
  name: "@community/tickets",
  version: "3.0.0",
  capabilities: {
    "tickets.classify": defineCapability(capability()),
  },
});

const passThrough = async ({ next }) => next();

export const capabilities = applyMiddleware(
  composeCapabilities({
    local: applyMiddleware(
      { "app.health": defineCapability(capability()) },
      passThrough,
    ),
    imports: [importCapabilities(tickets)],
  }),
  passThrough,
);
