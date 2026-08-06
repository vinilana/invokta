export const engine = {
  name: "duplicate-id-engine",
  version: "0.1.0",
  async invoke() {
    return {};
  },
  list: () => [
    { id: "fixture.duplicated", description: "First listing." },
    { id: "fixture.duplicated", description: "Second listing." },
  ],
  describe: () => ({
    id: "fixture.duplicated",
    description: "Duplicated fixture.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  }),
};
