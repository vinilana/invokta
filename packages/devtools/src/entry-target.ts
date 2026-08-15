import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Which composition root runs an emulated CLI or MCP stdio call, chartered by
 * ADR 0030. The devtools child is the default: it supplies the identity the
 * interface selected. The engine's own entry point supplies whatever its root
 * decides, including no principal at all, which is what the generated starter
 * does.
 */

/** The adapters whose composition root the developer can choose. */
export type EntryAdapter = "cli" | "mcp-stdio";

export const entryAdapters: readonly EntryAdapter[] = Object.freeze([
  "cli",
  "mcp-stdio",
]);

export type EntryPoint =
  | { readonly kind: "devtools" }
  | {
      readonly kind: "project";
      /** Project-relative path, as the developer named it. */
      readonly path: string;
      /** The absolute path the child is spawned with. */
      readonly resolvedPath: string;
    };

export type EntryPointView = Readonly<Record<EntryAdapter, EntryPointSummary>>;

export interface EntryPointSummary {
  readonly kind: EntryPoint["kind"];
  readonly path?: string;
}

export class EntryTargetError extends Error {
  constructor(
    readonly code: "INVALID_ADAPTER" | "INVALID_ENTRY_POINT",
    message: string,
  ) {
    super(message);
    this.name = "EntryTargetError";
  }
}

export interface EntryTargetStore {
  for(adapter: EntryAdapter): EntryPoint;
  view(): EntryPointView;
  set(adapter: EntryAdapter, entry: EntryPoint): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

const devtoolsEntry: EntryPoint = Object.freeze({ kind: "devtools" });

export function isEntryAdapter(value: unknown): value is EntryAdapter {
  return (
    typeof value === "string" && entryAdapters.includes(value as EntryAdapter)
  );
}

function isInside(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return (
    inside !== "" &&
    inside !== ".." &&
    !inside.startsWith(`..${sep}`) &&
    !isAbsolute(inside)
  );
}

/**
 * Validates an entry point the interface named. The path is resolved against
 * the directory `serve` runs in and must stay inside it: the devtools executes
 * what the developer points at, and the project is the boundary of that. The
 * comparison uses canonical filesystem identity, so a symlink inside the
 * project cannot name a file outside it — and the canonical path is what the
 * child is later spawned with, so retargeting the link after selection does
 * not move what runs.
 */
export function parseEntryPoint(value: unknown, cwd: string): EntryPoint {
  if (typeof value !== "object" || value === null) {
    throw new EntryTargetError(
      "INVALID_ENTRY_POINT",
      "The entry point is invalid.",
    );
  }
  const record = value as { readonly kind?: unknown; readonly path?: unknown };
  if (record.kind === "devtools") return devtoolsEntry;
  if (record.kind !== "project") {
    throw new EntryTargetError(
      "INVALID_ENTRY_POINT",
      "The entry point kind is unknown.",
    );
  }
  if (
    typeof record.path !== "string" ||
    record.path.trim() === "" ||
    record.path.includes("\0")
  ) {
    throw new EntryTargetError(
      "INVALID_ENTRY_POINT",
      "A project entry point requires a path inside the project.",
    );
  }
  const path = record.path.trim();
  const lexicalPath = resolve(cwd, path);
  if (!isInside(cwd, lexicalPath)) {
    throw new EntryTargetError(
      "INVALID_ENTRY_POINT",
      "The entry point must be inside the directory the dev server runs in.",
    );
  }
  let realCwd: string;
  let resolvedPath: string;
  try {
    realCwd = realpathSync(cwd);
    resolvedPath = realpathSync(lexicalPath);
  } catch {
    throw new EntryTargetError(
      "INVALID_ENTRY_POINT",
      "The entry point does not exist inside the project.",
    );
  }
  if (!isInside(realCwd, resolvedPath)) {
    throw new EntryTargetError(
      "INVALID_ENTRY_POINT",
      "The entry point must be inside the directory the dev server runs in.",
    );
  }
  return { kind: "project", path, resolvedPath };
}

export function createEntryTargetStore(): EntryTargetStore {
  const entries = new Map<EntryAdapter, EntryPoint>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A consumer failure must not affect the stored selection.
      }
    }
  };

  const summary = (adapter: EntryAdapter): EntryPointSummary => {
    const entry = entries.get(adapter) ?? devtoolsEntry;
    return entry.kind === "devtools"
      ? { kind: "devtools" }
      : { kind: "project", path: entry.path };
  };

  return {
    for: (adapter) => entries.get(adapter) ?? devtoolsEntry,
    view: () => ({ cli: summary("cli"), "mcp-stdio": summary("mcp-stdio") }),
    set: (adapter, entry) => {
      entries.set(adapter, entry);
      notify();
    },
    reset: () => {
      entries.clear();
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
