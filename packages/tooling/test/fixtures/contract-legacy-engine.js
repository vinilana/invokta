/**
 * An engine-shaped value whose descriptions predate the published access
 * kind, as produced by an older or foreign copy of the core.
 */
export const engine = {
  name: "legacy-engine",
  version: "1.0.0",
  list: () => [{ id: "legacy.read", description: "Reads legacy data." }],
  describe: () => ({
    id: "legacy.read",
    description: "Reads legacy data.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  }),
  invoke: async () => ({}),
};
