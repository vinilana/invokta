import { fixtureSecret } from "./support.js";

export const engine = {
  name: "broken-describe-engine",
  version: "0.1.0",
  async invoke() {
    return { marker: fixtureSecret };
  },
  list: () => [
    { id: "fixture.broken", description: `Broken (${fixtureSecret}).` },
  ],
  describe: () => {
    throw new Error("Fixture describe failed.");
  },
};
