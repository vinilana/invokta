import { createEngine } from "@ai-engine/core";

import type { ObsidianContextDependencies } from "./application/ports.js";
import { createListContextRoots } from "./capabilities/list-context-roots.js";
import { createOpenContextNode } from "./capabilities/open-context-node.js";
import { createFilesystemObsidianVault } from "./infrastructure/filesystem-obsidian-vault.js";

export function createObsidianContextEngine(
  dependencies: ObsidianContextDependencies,
) {
  return createEngine({
    name: "obsidian-context-engine",
    version: "0.1.0",
    capabilities: {
      "knowledge.list-context-roots": createListContextRoots(dependencies),
      "knowledge.open-context-node": createOpenContextNode(dependencies),
    },
  });
}

export interface ObsidianContextEnvironment {
  readonly OBSIDIAN_VAULT_PATH?: string | undefined;
}

/**
 * Composition root for a local, read-only Obsidian vault. The absolute vault
 * path stays in host configuration and never enters a capability contract.
 */
export function createConfiguredObsidianContextEngine(
  environment: ObsidianContextEnvironment = process.env,
) {
  const vaultPath = environment.OBSIDIAN_VAULT_PATH;
  if (vaultPath === undefined || vaultPath.trim() === "") {
    throw new Error("OBSIDIAN_VAULT_PATH is required.");
  }
  return createObsidianContextEngine({
    graph: createFilesystemObsidianVault({ vaultPath }),
  });
}
