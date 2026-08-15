import { createEngine, defineCapability } from "@invokta/core";

/**
 * The engine the adapter emulation tests run through every adapter. Its
 * capabilities report the execution facts each adapter is supposed to
 * establish — the source and the principal — and provide one input rejection
 * and one authentication rejection so the normalized outcome can be compared
 * across adapters.
 */

function permissiveSchema() {
  return {
    "~standard": {
      version: 1,
      vendor: "invokta-devtools-fixture",
      validate: (value) => ({ value }),
      jsonSchema: {
        input: () => ({
          type: "object",
          description: "Adapter fixture input.",
        }),
        output: () => ({
          type: "object",
          description: "Adapter fixture output.",
        }),
      },
    },
  };
}

function requiresMarkerSchema() {
  return {
    "~standard": {
      version: 1,
      vendor: "invokta-devtools-fixture",
      validate: (value) =>
        typeof value === "object" &&
        value !== null &&
        typeof value.marker === "string"
          ? { value }
          : { issues: [{ message: "marker must be a string." }] },
      jsonSchema: {
        input: () => ({
          type: "object",
          properties: { marker: { type: "string" } },
          required: ["marker"],
        }),
        output: () => ({ type: "object", description: "Accepted marker." }),
      },
    },
  };
}

const report = defineCapability({
  title: "Report execution facts",
  description: "Reports the source and principal the adapter established.",
  input: permissiveSchema(),
  output: permissiveSchema(),
  access: "public",
  async run({ input, context }) {
    return {
      input,
      source: context.source,
      principalId: context.principal === null ? null : context.principal.id,
    };
  },
});

const strict = defineCapability({
  description: "Accepts only an object carrying a string marker.",
  input: requiresMarkerSchema(),
  output: permissiveSchema(),
  access: "public",
  async run({ input }) {
    return { marker: input.marker };
  },
});

const guarded = defineCapability({
  description: "Requires an authenticated principal.",
  input: permissiveSchema(),
  output: permissiveSchema(),
  access: "authenticated",
  async run({ context }) {
    return { principalId: context.principal?.id ?? null };
  },
});

export const engine = createEngine({
  name: "adapter-fixture-engine",
  version: "1.0.0",
  capabilities: {
    "fixture.report": report,
    "fixture.strict": strict,
    "fixture.guarded": guarded,
  },
});
