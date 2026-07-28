import { defineCapabilityLibrary } from "@ai-engine/core";

import type { CommunityLibraryDependencies } from "./application/ports.js";
import { createDraftReply } from "./capabilities/draft-reply.js";
import { createSearchKnowledgeBase } from "./capabilities/search-knowledge-base.js";
import { createSummarizeThread } from "./capabilities/summarize-thread.js";

/**
 * The library bundle publishes related capabilities under literal default IDs.
 * The map key order is part of the published contract: a selected capability
 * keeps its position when an importer remaps it.
 */
export function createCommunitySupportLibrary(
  dependencies: CommunityLibraryDependencies,
) {
  return defineCapabilityLibrary({
    name: "@ai-engine/example-community-capabilities/library",
    version: "1.4.0",
    capabilities: {
      "community.summarize-thread": createSummarizeThread(dependencies),
      "community.search-knowledge-base":
        createSearchKnowledgeBase(dependencies),
      "community.draft-reply": createDraftReply(dependencies),
    },
  });
}
