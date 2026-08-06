export const engine = {
  name: "schema-unreadable-engine",
  version: "0.1.0",
  async invoke() {
    return {};
  },
  list: () => [{ id: "fixture.opaque", description: "Opaque fixture." }],
  describe: () => ({
    id: "fixture.opaque",
    title: "Opaque fixture",
    description: "Opaque fixture.",
    annotations: { readOnly: true },
    inputSchema: null,
    outputSchema: { type: "object" },
  }),
};
