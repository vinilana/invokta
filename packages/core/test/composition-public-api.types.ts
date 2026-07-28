import { expectTypeOf } from "vitest";
import { z } from "zod";

import {
  composeCapabilities,
  createEngine,
  defineCapability,
  defineCapabilityLibrary,
  defineExportedCapability,
  importCapabilities,
  importCapability,
} from "../src/index.js";

const classifyInput = z.object({
  ticketId: z.string().transform((ticketId) => ticketId.length),
});
const classifyOutput = z.object({
  category: z.string().transform((category) => category.toUpperCase()),
});

const classifyTicket = defineCapability({
  description: "Classify a support ticket.",
  input: classifyInput,
  output: classifyOutput,
  access: "public",
  async run({ input }) {
    expectTypeOf(input).toEqualTypeOf<{ ticketId: number }>();
    return { category: String(input.ticketId) };
  },
});

const summarizeTicket = defineCapability({
  description: "Summarize a support ticket.",
  input: z.object({ ticketId: z.string() }),
  output: z.object({ summary: z.string() }),
  access: "public",
  run: async () => ({ summary: "" }),
});

const generateReport = defineCapability({
  description: "Generate an operations report.",
  input: z.object({ period: z.string() }),
  output: z.object({ url: z.string() }),
  access: "public",
  run: async () => ({ url: "" }),
});

const exportedClassify = defineExportedCapability({
  source: { name: "@community/support-capabilities", version: "1.4.0" },
  defaultId: "support.classify-ticket",
  capability: classifyTicket,
});

const supportLibrary = defineCapabilityLibrary({
  name: "@community/support-capabilities",
  version: "1.4.0",
  capabilities: {
    "support.classify-ticket": classifyTicket,
    "support.summarize-ticket": summarizeTicket,
  },
});

// AE-AC-02: an atomic import without `as` mounts the exported default ID.
const defaultIdEngine = createEngine({
  name: "operations-engine",
  version: "2.0.0",
  capabilities: composeCapabilities({
    local: { "operations.generate-report": generateReport },
    imports: [
      importCapability(exportedClassify),
      importCapabilities(supportLibrary, {
        include: ["support.summarize-ticket"],
      }),
    ],
  }),
});

expectTypeOf(
  defaultIdEngine.invoke("support.classify-ticket", { ticketId: "T-1" }),
).resolves.toEqualTypeOf<{ category: string }>();
expectTypeOf(
  defaultIdEngine.invoke("support.summarize-ticket", { ticketId: "T-1" }),
).resolves.toEqualTypeOf<{ summary: string }>();
expectTypeOf(
  defaultIdEngine.invoke("operations.generate-report", { period: "2026-07" }),
).resolves.toEqualTypeOf<{ url: string }>();

// AE-AC-03: `as` and `remap` register only the effective ID.
const remappedEngine = createEngine({
  name: "operations-engine",
  version: "2.0.0",
  capabilities: composeCapabilities({
    imports: [
      importCapability(exportedClassify, { as: "operations.classify-ticket" }),
      importCapabilities(supportLibrary, {
        include: ["support.summarize-ticket"],
        remap: { "support.summarize-ticket": "operations.summarize-ticket" },
      }),
    ],
  }),
});

expectTypeOf(
  remappedEngine.invoke("operations.classify-ticket", { ticketId: "T-1" }),
).resolves.toEqualTypeOf<{ category: string }>();
expectTypeOf(
  remappedEngine.invoke("operations.summarize-ticket", { ticketId: "T-1" }),
).resolves.toEqualTypeOf<{ summary: string }>();

// @ts-expect-error A remapped default ID is no longer mounted.
remappedEngine.invoke("support.classify-ticket", { ticketId: "T-1" });

// @ts-expect-error A remapped library default ID is no longer mounted.
remappedEngine.invoke("support.summarize-ticket", { ticketId: "T-1" });

// AE-AC-09: a remapped ID preserves the exact input and output inference.
// @ts-expect-error Invocation input uses the schema input type, not its output type.
remappedEngine.invoke("operations.classify-ticket", { ticketId: 4 });

expectTypeOf(
  remappedEngine.invoke("operations.classify-ticket", { ticketId: "T-1" }),
).resolves.not.toEqualTypeOf<{ category: string; extra: string }>();

// AE-AC-08 and AE-AC-17: a bare capability definition is not an atomic export.
importCapability(
  // @ts-expect-error A bare CapabilityDefinition carries no default ID or provenance.
  classifyTicket,
);

// A bare capability definition stays valid as a local declaration.
expectTypeOf(
  createEngine({
    name: "operations-engine",
    version: "2.0.0",
    capabilities: composeCapabilities({
      local: { "support.classify-ticket": classifyTicket },
    }),
  }).invoke("support.classify-ticket", { ticketId: "T-1" }),
).resolves.toEqualTypeOf<{ category: string }>();

// AE-AC-08: an `include` entry must be a library default ID.
importCapabilities(supportLibrary, {
  // @ts-expect-error The library does not export this default ID.
  include: ["support.escalate-ticket"],
});

// AE-AC-08: a `remap` key must be a library default ID.
importCapabilities(supportLibrary, {
  // @ts-expect-error The library does not export this default ID.
  remap: { "support.escalate-ticket": "operations.escalate-ticket" },
});

// AE-AC-08: a `remap` key must be selected by `include`.
importCapabilities(supportLibrary, {
  include: ["support.classify-ticket"],
  // @ts-expect-error The remap key is not part of the include selection.
  remap: { "support.summarize-ticket": "operations.summarize-ticket" },
});

// Two remap targets inside one import cannot share an effective ID.
// @ts-expect-error Both default IDs remap onto one effective ID.
importCapabilities(supportLibrary, {
  remap: {
    "support.classify-ticket": "operations.ticket",
    "support.summarize-ticket": "operations.ticket",
  },
});

// A remap target widened to `string` escapes the static gate instead of
// poisoning it: neither a literal sibling nor a second widened target may be
// flagged as a duplicate, and the runtime pass stays authoritative.
declare const widenedTarget: string;
importCapabilities(supportLibrary, {
  remap: {
    "support.classify-ticket": widenedTarget,
    "support.summarize-ticket": "operations.summarize-ticket",
  },
});
importCapabilities(supportLibrary, {
  remap: {
    "support.classify-ticket": widenedTarget,
    "support.summarize-ticket": widenedTarget,
  },
});

// AE-AC-18: local and atomic default collide.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    local: { "support.classify-ticket": classifyTicket },
    imports: [importCapability(exportedClassify)],
  },
);

// AE-AC-18: local and library effective ID collide.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    local: { "support.classify-ticket": classifyTicket },
    imports: [
      importCapabilities(supportLibrary, {
        include: ["support.classify-ticket"],
      }),
    ],
  },
);

// AE-AC-18: two atomic defaults collide.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    imports: [
      importCapability(exportedClassify),
      importCapability(exportedClassify),
    ],
  },
);

// AE-AC-18: an atomic default and a library effective ID collide.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    imports: [
      importCapability(exportedClassify),
      importCapabilities(supportLibrary, {
        include: ["support.classify-ticket"],
      }),
    ],
  },
);

// AE-AC-18: two library imports collide.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    imports: [
      importCapabilities(supportLibrary, {
        include: ["support.classify-ticket"],
      }),
      importCapabilities(supportLibrary, {
        include: ["support.classify-ticket"],
      }),
    ],
  },
);

// AE-AC-18: an atomic `as` target collides with a local ID.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    local: { "operations.classify-ticket": classifyTicket },
    imports: [
      importCapability(exportedClassify, { as: "operations.classify-ticket" }),
    ],
  },
);

// AE-AC-18: an atomic `as` target collides with an atomic default ID.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    imports: [
      importCapability(exportedClassify),
      importCapability(exportedClassify, { as: "support.classify-ticket" }),
    ],
  },
);

// AE-AC-18: an atomic `as` target collides with a library remap target.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    imports: [
      importCapabilities(supportLibrary, {
        include: ["support.summarize-ticket"],
        remap: { "support.summarize-ticket": "operations.ticket" },
      }),
      importCapability(exportedClassify, { as: "operations.ticket" }),
    ],
  },
);

// AE-AC-18: two library remap targets collide across imports.
composeCapabilities(
  // @ts-expect-error Duplicate effective capability IDs are rejected.
  {
    imports: [
      importCapabilities(supportLibrary, {
        include: ["support.classify-ticket"],
        remap: { "support.classify-ticket": "operations.ticket" },
      }),
      importCapabilities(supportLibrary, {
        include: ["support.summarize-ticket"],
        remap: { "support.summarize-ticket": "operations.ticket" },
      }),
    ],
  },
);

// A remapped default ID frees its original ID for another declaration.
expectTypeOf(
  createEngine({
    name: "operations-engine",
    version: "2.0.0",
    capabilities: composeCapabilities({
      local: { "support.classify-ticket": summarizeTicket },
      imports: [
        importCapability(exportedClassify, {
          as: "operations.classify-ticket",
        }),
      ],
    }),
  }).invoke("support.classify-ticket", { ticketId: "T-1" }),
).resolves.toEqualTypeOf<{ summary: string }>();
