import {
  composeCapabilities,
  createEngine,
  defineCapability,
} from "@invokta/core";

import { fixtureSecret, schema } from "./support.js";

const echo = defineCapability({
  description: `Echoes the fixture input (${fixtureSecret}).`,
  input: schema(),
  output: schema(),
  access: "public",
  async run({ input }) {
    return input;
  },
});

const greet = defineCapability({
  title: "Fixture greeting",
  description: `Greets the fixture caller (${fixtureSecret}).`,
  annotations: { readOnly: true },
  input: schema(),
  output: schema(),
  access: "public",
  async run() {
    return { marker: fixtureSecret };
  },
});

export const capabilities = composeCapabilities({
  local: { "fixture.echo": echo, "fixture.greet": greet },
  imports: [],
});

export const engine = createEngine({
  name: "fixture-engine",
  version: "0.1.0",
  capabilities,
});
