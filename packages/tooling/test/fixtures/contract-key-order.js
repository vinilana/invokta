import { createEngine } from "@invokta/core";

/**
 * Two engines whose JSON Schema documents contain the same keywords inserted
 * in a different order. Their contract snapshots must be byte-identical.
 */
function schema(document) {
  return {
    "~standard": {
      version: 1,
      vendor: "invokta-tooling-fixture",
      validate: (value) => ({ value }),
      jsonSchema: {
        input: () => document,
        output: () => document,
      },
    },
  };
}

function capability(document) {
  return {
    description: "Returns its input.",
    input: schema(document),
    output: schema(document),
    access: "public",
    async run({ input }) {
      return input;
    },
  };
}

export const forward = createEngine({
  name: "key-order-engine",
  version: "1.0.0",
  capabilities: {
    "orders.read": capability({
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        count: { type: "integer", minimum: 0 },
      },
      required: ["id"],
    }),
  },
});

export const reverse = createEngine({
  name: "key-order-engine",
  version: "1.0.0",
  capabilities: {
    "orders.read": capability({
      required: ["id"],
      properties: {
        count: { minimum: 0, type: "integer" },
        id: { minLength: 1, type: "string" },
      },
      type: "object",
    }),
  },
});
