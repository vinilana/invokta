export const devEngine = {
  name: "named-fixture-engine",
  version: "0.1.0",
  async invoke() {
    return {};
  },
  list: () => [],
  describe: () => {
    throw new Error("The named fixture engine describes nothing.");
  },
};
