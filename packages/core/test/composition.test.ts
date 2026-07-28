import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AnyCapability,
  type AnyCapabilityImport,
  CapabilityCompositionError,
  type CapabilityCompositionIssue,
  type CapabilityDeclarationProvenance,
  type CapabilityMap,
  composeCapabilities,
  createEngine,
  defineCapability,
  defineCapabilityLibrary,
  defineExportedCapability,
  importCapabilities,
  importCapability,
  isCapabilityCompositionError,
  isComposedCapabilities,
} from "../src/index.js";

const secretMarker = "SECRET-do-not-leak";

const ticketInput = z.object({ ticketId: z.string().min(1) });
const ticketOutput = z.object({ category: z.string() });

/**
 * Runtime collision tables intentionally build compositions the static gate
 * rejects, so they call the erased signature instead of the typed one.
 */
const composeUnchecked = composeCapabilities as unknown as (declaration: {
  readonly local?: CapabilityMap;
  readonly imports?: readonly AnyCapabilityImport[];
}) => CapabilityMap;

function trackedCapability(): {
  readonly capability: AnyCapability;
  readonly run: ReturnType<typeof vi.fn>;
  readonly access: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async () => ({ category: `billing-${secretMarker}` }));
  const access = vi.fn(() => true);
  const capability = defineCapability({
    title: `Classify ${secretMarker}`,
    description: `Classify a support ticket. ${secretMarker}`,
    input: ticketInput,
    output: ticketOutput,
    access,
    run,
  });
  return { capability: capability as AnyCapability, run, access };
}

function plainCapability(
  description = "Classify a support ticket.",
): AnyCapability {
  return defineCapability({
    description,
    input: ticketInput,
    output: ticketOutput,
    access: "public",
    run: async () => ({ category: "billing" }),
  }) as AnyCapability;
}

function exportedClassify(defaultId = "support.classify-ticket") {
  return defineExportedCapability({
    source: { name: "@community/support-capabilities", version: "1.4.0" },
    defaultId,
    capability: plainCapability(),
  });
}

function supportLibrary() {
  return defineCapabilityLibrary({
    name: "@community/support-capabilities",
    version: "1.4.0",
    capabilities: {
      "support.classify-ticket": plainCapability("Classify a support ticket."),
      "support.summarize-ticket": plainCapability(
        "Summarize a support ticket.",
      ),
    },
  });
}

function captureCompositionError(
  run: () => unknown,
): CapabilityCompositionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityCompositionError);
    expect(error).toBeInstanceOf(TypeError);
    return error as CapabilityCompositionError;
  }
  throw new Error("Expected composition to throw CapabilityCompositionError.");
}

function collisionIds(
  error: CapabilityCompositionError,
): ReadonlyArray<string> {
  return error.issues
    .filter((issue) => issue.code === "CAPABILITY_ID_COLLISION")
    .map((issue) => issue.effectiveId);
}

function provenanceKinds(
  error: CapabilityCompositionError,
  effectiveId: string,
): ReadonlyArray<CapabilityDeclarationProvenance["kind"]> {
  const issue = error.issues.find(
    (candidate) =>
      candidate.code === "CAPABILITY_ID_COLLISION" &&
      candidate.effectiveId === effectiveId,
  );
  if (issue === undefined || issue.code !== "CAPABILITY_ID_COLLISION") {
    throw new Error(`Expected a collision issue for ${effectiveId}.`);
  }
  return issue.declarations.map((declaration) => declaration.kind);
}

const allowedIssueKeys = new Set([
  "code",
  "effectiveId",
  "declarations",
  "importKind",
  "reason",
  "libraryName",
  "defaultId",
]);
const allowedProvenanceKeys = new Set([
  "kind",
  "localId",
  "sourceName",
  "sourceVersion",
  "libraryName",
  "libraryVersion",
  "defaultId",
]);

function assertPayloadFree(
  issues: ReadonlyArray<CapabilityCompositionIssue>,
): void {
  for (const issue of issues) {
    for (const key of Object.keys(issue)) {
      expect(allowedIssueKeys).toContain(key);
      const value: unknown = (issue as Readonly<Record<string, unknown>>)[key];
      if (key === "declarations") {
        expect(Array.isArray(value)).toBe(true);
        for (const declaration of value as ReadonlyArray<
          Readonly<Record<string, unknown>>
        >) {
          for (const declarationKey of Object.keys(declaration)) {
            expect(allowedProvenanceKeys).toContain(declarationKey);
            expect(declaration[declarationKey]).toBeTypeOf("string");
          }
        }
      } else {
        expect(value).toBeTypeOf("string");
      }
    }
  }
  expect(JSON.stringify(issues)).not.toContain(secretMarker);
}

describe("atomic export and library descriptors", () => {
  it("wraps a capability definition without altering it", () => {
    const capability = plainCapability();
    const exported = defineExportedCapability({
      source: { name: "@community/support-capabilities", version: "1.4.0" },
      defaultId: "support.classify-ticket",
      capability,
    });

    expect(exported.defaultId).toBe("support.classify-ticket");
    expect(exported.capability).toBe(capability);
    expect(exported.source).toEqual({
      name: "@community/support-capabilities",
      version: "1.4.0",
    });
  });

  it("accepts atomic source metadata without a version", () => {
    const exported = defineExportedCapability({
      source: { name: "./shared/classify-ticket.js" },
      defaultId: "support.classify-ticket",
      capability: plainCapability(),
    });

    expect(Object.hasOwn(exported.source, "version")).toBe(false);
  });

  it.each([
    ["empty name", { name: "" }],
    ["non-string name", { name: 42 }],
    ["missing name", {}],
    ["empty version", { name: "@community/support", version: "" }],
    ["non-string version", { name: "@community/support", version: 1 }],
  ])("rejects invalid atomic source metadata: %s", (_label, source) => {
    expect(() =>
      defineExportedCapability({
        source: source as { readonly name: string },
        defaultId: "support.classify-ticket",
        capability: plainCapability(),
      }),
    ).toThrow(TypeError);
  });

  it.each([
    ["empty default ID", ""],
    ["non-string default ID", 7],
  ])("rejects an invalid atomic default ID: %s", (_label, defaultId) => {
    expect(() =>
      defineExportedCapability({
        source: { name: "@community/support-capabilities" },
        defaultId: defaultId as string,
        capability: plainCapability(),
      }),
    ).toThrow(TypeError);
  });

  it("freezes the atomic descriptor so later mutation cannot change composition", () => {
    const exported = exportedClassify();

    expect(Object.isFrozen(exported)).toBe(true);
    expect(Object.isFrozen(exported.source)).toBe(true);
    expect(() => {
      (exported as unknown as { defaultId: string }).defaultId = "ops.hijacked";
    }).toThrow(TypeError);
    expect(() => {
      (exported.source as unknown as { name: string }).name = "@evil/source";
    }).toThrow(TypeError);

    const composed = composeCapabilities({
      imports: [importCapability(exported)],
    });

    expect(Object.keys(composed)).toEqual(["support.classify-ticket"]);
  });

  it.each([
    ["empty name", { name: "", version: "1.0.0" }],
    ["non-string name", { name: 3, version: "1.0.0" }],
    ["empty version", { name: "@community/support", version: "" }],
    ["non-string version", { name: "@community/support", version: 3 }],
    ["missing version", { name: "@community/support" }],
  ])("rejects invalid library metadata: %s", (_label, metadata) => {
    expect(() =>
      defineCapabilityLibrary({
        ...(metadata as { readonly name: string; readonly version: string }),
        capabilities: { "support.classify-ticket": plainCapability() },
      }),
    ).toThrow(TypeError);
  });

  it.each([
    ["null capability map", null],
    ["array capability map", []],
    ["string capability map", "capabilities"],
  ])(
    "rejects an invalid library capability map: %s",
    (_label, capabilities) => {
      expect(() =>
        defineCapabilityLibrary({
          name: "@community/support-capabilities",
          version: "1.4.0",
          capabilities: capabilities as unknown as CapabilityMap,
        }),
      ).toThrow(TypeError);
    },
  );

  it("freezes the library descriptor and snapshots its capability map", () => {
    const source = {
      "support.classify-ticket": plainCapability(),
    };
    const library = defineCapabilityLibrary({
      name: "@community/support-capabilities",
      version: "1.4.0",
      capabilities: source,
    });

    expect(Object.isFrozen(library)).toBe(true);
    expect(Object.isFrozen(library.capabilities)).toBe(true);
    (source as Record<string, AnyCapability>)["support.injected"] =
      plainCapability();

    const composed = composeCapabilities({
      imports: [importCapabilities(library)],
    });

    expect(Object.keys(composed)).toEqual(["support.classify-ticket"]);
  });

  it("never touches the handler, access rule, or schemas while describing", () => {
    const tracked = trackedCapability();
    const exported = defineExportedCapability({
      source: { name: "@community/support-capabilities" },
      defaultId: "support.classify-ticket",
      capability: tracked.capability,
    });
    const library = defineCapabilityLibrary({
      name: "@community/support-capabilities",
      version: "1.4.0",
      capabilities: { "support.summarize-ticket": tracked.capability },
    });

    composeCapabilities({
      imports: [importCapability(exported), importCapabilities(library)],
    });

    expect(tracked.run).not.toHaveBeenCalled();
    expect(tracked.access).not.toHaveBeenCalled();
  });
});

describe("composition resolution", () => {
  it("mounts default IDs for atomic and library imports", () => {
    const composed = composeCapabilities({
      local: { "operations.generate-report": plainCapability() },
      imports: [
        importCapability(exportedClassify("support.classify-ticket")),
        importCapabilities(supportLibrary(), {
          include: ["support.summarize-ticket"],
        }),
      ],
    });

    expect(Object.keys(composed)).toEqual([
      "operations.generate-report",
      "support.classify-ticket",
      "support.summarize-ticket",
    ]);
  });

  it("registers only the effective ID after an atomic remap", () => {
    const composed = composeCapabilities({
      imports: [
        importCapability(exportedClassify(), {
          as: "operations.classify-ticket",
        }),
      ],
    });

    expect(Object.keys(composed)).toEqual(["operations.classify-ticket"]);
  });

  it("registers only the effective ID after a library remap", () => {
    const composed = composeCapabilities({
      imports: [
        importCapabilities(supportLibrary(), {
          include: ["support.classify-ticket"],
          remap: { "support.classify-ticket": "operations.classify-ticket" },
        }),
      ],
    });

    expect(Object.keys(composed)).toEqual(["operations.classify-ticket"]);
  });

  it("keeps the library map order when remapping changes only the key", () => {
    const composed = composeCapabilities({
      imports: [
        importCapabilities(supportLibrary(), {
          remap: { "support.classify-ticket": "zz.classify-ticket" },
        }),
      ],
    });

    expect(Object.keys(composed)).toEqual([
      "zz.classify-ticket",
      "support.summarize-ticket",
    ]);
  });

  it("composes local declarations before imports in a deterministic order", () => {
    const declaration = {
      local: {
        "operations.generate-report": plainCapability(),
        "operations.audit": plainCapability(),
      },
      imports: [
        importCapabilities(supportLibrary()),
        importCapability(exportedClassify("support.escalate-ticket")),
      ],
    } as const;

    const first = composeCapabilities(declaration);
    const second = composeCapabilities(declaration);
    const expected = [
      "operations.generate-report",
      "operations.audit",
      "support.classify-ticket",
      "support.summarize-ticket",
      "support.escalate-ticket",
    ];

    expect(Object.keys(first)).toEqual(expected);
    expect(Object.keys(second)).toEqual(expected);
  });

  it("returns a frozen map carrying a non-enumerable composition brand", () => {
    const composed = composeCapabilities({
      local: { "operations.generate-report": plainCapability() },
    });
    const brand = Symbol.for("@ai-engine/core.composedCapabilities");

    expect(Object.isFrozen(composed)).toBe(true);
    expect(Object.keys(composed)).toEqual(["operations.generate-report"]);
    expect(Object.getOwnPropertySymbols(composed)).toEqual([brand]);
    expect(Object.prototype.propertyIsEnumerable.call(composed, brand)).toBe(
      false,
    );
    expect(JSON.stringify(Object.keys(composed))).toBe(
      '["operations.generate-report"]',
    );
    expect(isComposedCapabilities(composed)).toBe(true);
  });

  it("reports an untracked flattened map as an unbranded composition", () => {
    const composed = composeCapabilities({
      local: { "operations.generate-report": plainCapability() },
    });

    expect(isComposedCapabilities({ ...composed })).toBe(false);
    expect(isComposedCapabilities({})).toBe(false);
    expect(isComposedCapabilities(null)).toBe(false);
    expect(isComposedCapabilities(new Proxy({}, {}))).toBe(false);
  });

  it("creates a working engine from a composed map", async () => {
    const composed = composeCapabilities({
      local: { "operations.generate-report": plainCapability("Report.") },
      imports: [
        importCapabilities(supportLibrary(), {
          include: ["support.classify-ticket"],
          remap: { "support.classify-ticket": "operations.classify-ticket" },
        }),
      ],
    });
    const engine = createEngine({
      name: "operations-engine",
      version: "2.0.0",
      capabilities: composed,
    });

    expect(engine.list().map((summary) => summary.id)).toEqual([
      "operations.generate-report",
      "operations.classify-ticket",
    ]);
    await expect(
      engine.invoke("operations.classify-ticket", { ticketId: "T-1" }),
    ).resolves.toEqual({ category: "billing" });
    await expect(
      engine.invoke("support.classify-ticket" as "operations.classify-ticket", {
        ticketId: "T-1",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_FOUND" });
  });
});

describe("collision detection", () => {
  const collisionCases: ReadonlyArray<
    readonly [
      string,
      () => CapabilityMap,
      string,
      ReadonlyArray<CapabilityDeclarationProvenance["kind"]>,
    ]
  > = [
    [
      "local and atomic",
      () =>
        composeUnchecked({
          local: { "support.classify-ticket": plainCapability() },
          imports: [importCapability(exportedClassify())],
        }),
      "support.classify-ticket",
      ["local", "atomic"],
    ],
    [
      "local and library",
      () =>
        composeUnchecked({
          local: { "support.classify-ticket": plainCapability() },
          imports: [
            importCapabilities(supportLibrary(), {
              include: ["support.classify-ticket"],
            }),
          ],
        }),
      "support.classify-ticket",
      ["local", "library"],
    ],
    [
      "atomic and atomic",
      () =>
        composeUnchecked({
          imports: [
            importCapability(exportedClassify()),
            importCapability(exportedClassify()),
          ],
        }),
      "support.classify-ticket",
      ["atomic", "atomic"],
    ],
    [
      "atomic and library",
      () =>
        composeUnchecked({
          imports: [
            importCapability(exportedClassify()),
            importCapabilities(supportLibrary(), {
              include: ["support.classify-ticket"],
            }),
          ],
        }),
      "support.classify-ticket",
      ["atomic", "library"],
    ],
    [
      "library and library",
      () =>
        composeUnchecked({
          imports: [
            importCapabilities(supportLibrary(), {
              include: ["support.classify-ticket"],
            }),
            importCapabilities(supportLibrary(), {
              include: ["support.classify-ticket"],
            }),
          ],
        }),
      "support.classify-ticket",
      ["library", "library"],
    ],
    [
      "library default and library remap",
      () =>
        composeUnchecked({
          imports: [
            importCapabilities(supportLibrary(), {
              include: ["support.summarize-ticket"],
            }),
            importCapabilities(supportLibrary(), {
              include: ["support.classify-ticket"],
              remap: {
                "support.classify-ticket": "support.summarize-ticket",
              },
            }),
          ],
        }),
      "support.summarize-ticket",
      ["library", "library"],
    ],
    [
      "library remap and library remap",
      () =>
        composeUnchecked({
          imports: [
            importCapabilities(supportLibrary(), {
              include: ["support.classify-ticket"],
              remap: { "support.classify-ticket": "operations.shared" },
            }),
            importCapabilities(supportLibrary(), {
              include: ["support.summarize-ticket"],
              remap: { "support.summarize-ticket": "operations.shared" },
            }),
          ],
        }),
      "operations.shared",
      ["library", "library"],
    ],
    [
      "atomic remap target and local ID",
      () =>
        composeUnchecked({
          local: { "operations.classify-ticket": plainCapability() },
          imports: [
            importCapability(exportedClassify(), {
              as: "operations.classify-ticket",
            }),
          ],
        }),
      "operations.classify-ticket",
      ["local", "atomic"],
    ],
    [
      "atomic remap target and atomic default",
      () =>
        composeUnchecked({
          imports: [
            importCapability(exportedClassify("operations.classify-ticket")),
            importCapability(exportedClassify(), {
              as: "operations.classify-ticket",
            }),
          ],
        }),
      "operations.classify-ticket",
      ["atomic", "atomic"],
    ],
    [
      "atomic remap target and library effective ID",
      () =>
        composeUnchecked({
          imports: [
            importCapabilities(supportLibrary(), {
              include: ["support.classify-ticket"],
              remap: {
                "support.classify-ticket": "operations.classify-ticket",
              },
            }),
            importCapability(exportedClassify(), {
              as: "operations.classify-ticket",
            }),
          ],
        }),
      "operations.classify-ticket",
      ["library", "atomic"],
    ],
  ];

  it.each(collisionCases)(
    "fails composition for a %s collision",
    (_label, compose, effectiveId, kinds) => {
      const error = captureCompositionError(compose);

      expect(error.code).toBe("CAPABILITY_COMPOSITION_INVALID");
      expect(error.message).toBe("Capability composition is invalid.");
      expect(error.name).toBe("CapabilityCompositionError");
      expect(collisionIds(error)).toEqual([effectiveId]);
      expect(provenanceKinds(error, effectiveId)).toEqual(kinds);
      assertPayloadFree(error.issues);
    },
  );

  it("collides when the same capability object is imported twice", () => {
    const exported = exportedClassify();
    const error = captureCompositionError(() =>
      composeUnchecked({
        imports: [importCapability(exported), importCapability(exported)],
      }),
    );

    expect(collisionIds(error)).toEqual(["support.classify-ticket"]);
    expect(provenanceKinds(error, "support.classify-ticket")).toEqual([
      "atomic",
      "atomic",
    ]);
  });

  it("collides when the same local capability object is mounted by an import", () => {
    const capability = plainCapability();
    const exported = defineExportedCapability({
      source: { name: "@community/support-capabilities" },
      defaultId: "support.classify-ticket",
      capability,
    });
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: { "support.classify-ticket": capability },
        imports: [importCapability(exported)],
      }),
    );

    expect(collisionIds(error)).toEqual(["support.classify-ticket"]);
  });

  it("reports every collision in one deterministic, payload-free pass", () => {
    const tracked = trackedCapability();
    const exported = defineExportedCapability({
      source: { name: "@community/support-capabilities", version: "1.4.0" },
      defaultId: "zeta.capability",
      capability: tracked.capability,
    });
    const library = defineCapabilityLibrary({
      name: "@community/support-capabilities",
      version: "1.4.0",
      capabilities: {
        "zeta.capability": tracked.capability,
        "alpha.capability": tracked.capability,
      },
    });
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: {
          "zeta.capability": tracked.capability,
          "alpha.capability": tracked.capability,
        },
        imports: [importCapability(exported), importCapabilities(library)],
      }),
    );

    expect(collisionIds(error)).toEqual([
      "alpha.capability",
      "zeta.capability",
    ]);
    expect(
      error.issues.filter((issue) => issue.code === "CAPABILITY_ID_COLLISION"),
    ).toHaveLength(2);
    expect(provenanceKinds(error, "zeta.capability")).toEqual([
      "local",
      "atomic",
      "library",
    ]);
    expect(provenanceKinds(error, "alpha.capability")).toEqual([
      "local",
      "library",
    ]);
    assertPayloadFree(error.issues);
    expect(tracked.run).not.toHaveBeenCalled();
    expect(tracked.access).not.toHaveBeenCalled();
  });

  it("carries complete provenance for local, atomic, and library declarations", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: { "support.classify-ticket": plainCapability() },
        imports: [
          importCapability(
            defineExportedCapability({
              source: { name: "./shared/classify-ticket.js" },
              defaultId: "support.classify-ticket",
              capability: plainCapability(),
            }),
          ),
          importCapabilities(supportLibrary(), {
            include: ["support.summarize-ticket"],
            remap: { "support.summarize-ticket": "support.classify-ticket" },
          }),
        ],
      }),
    );

    expect(error.issues).toEqual([
      {
        code: "CAPABILITY_ID_COLLISION",
        effectiveId: "support.classify-ticket",
        declarations: [
          { kind: "local", localId: "support.classify-ticket" },
          {
            kind: "atomic",
            sourceName: "./shared/classify-ticket.js",
            defaultId: "support.classify-ticket",
          },
          {
            kind: "library",
            libraryName: "@community/support-capabilities",
            libraryVersion: "1.4.0",
            defaultId: "support.summarize-ticket",
          },
        ],
      },
    ]);
  });

  it("includes the atomic source version when it was declared", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: { "support.classify-ticket": plainCapability() },
        imports: [importCapability(exportedClassify())],
      }),
    );
    const issue = error.issues[0];

    expect(issue?.code).toBe("CAPABILITY_ID_COLLISION");
    expect(
      issue?.code === "CAPABILITY_ID_COLLISION"
        ? issue.declarations[1]
        : undefined,
    ).toEqual({
      kind: "atomic",
      sourceName: "@community/support-capabilities",
      sourceVersion: "1.4.0",
      defaultId: "support.classify-ticket",
    });
  });

  it("sorts collision issues by code unit rather than locale", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: {
          "Zeta.capability": plainCapability(),
          "alpha.capability": plainCapability(),
        },
        imports: [
          importCapability(exportedClassify("Zeta.capability")),
          importCapability(exportedClassify("alpha.capability")),
        ],
      }),
    );

    expect(collisionIds(error)).toEqual([
      "Zeta.capability",
      "alpha.capability",
    ]);
  });
});

describe("import boundary validation", () => {
  it("rejects a bare capability definition passed to importCapability", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        imports: [importCapability(plainCapability() as never)],
      }),
    );

    expect(error.issues).toEqual([
      {
        code: "CAPABILITY_IMPORT_INVALID",
        importKind: "atomic",
        reason: "EXPORTED_CAPABILITY_REQUIRED",
      },
    ]);
    assertPayloadFree(error.issues);
  });

  it("keeps a bare capability definition valid as a local declaration", () => {
    const composed = composeCapabilities({
      local: { "support.classify-ticket": plainCapability() },
    });

    expect(Object.keys(composed)).toEqual(["support.classify-ticket"]);
  });

  it("reports an unknown include entry", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        imports: [
          importCapabilities(supportLibrary(), {
            include: ["support.unknown" as "support.classify-ticket"],
          }),
        ],
      }),
    );

    expect(error.issues).toEqual([
      {
        code: "CAPABILITY_IMPORT_ID_NOT_FOUND",
        libraryName: "@community/support-capabilities",
        defaultId: "support.unknown",
      },
    ]);
    assertPayloadFree(error.issues);
  });

  it("reports an unknown remap key", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        imports: [
          importCapabilities(supportLibrary(), {
            remap: { "support.unknown": "operations.classify-ticket" } as never,
          }),
        ],
      }),
    );

    expect(error.issues).toEqual([
      {
        code: "CAPABILITY_IMPORT_ID_NOT_FOUND",
        libraryName: "@community/support-capabilities",
        defaultId: "support.unknown",
      },
    ]);
  });

  it("reports a remap key that include did not select", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        imports: [
          importCapabilities(supportLibrary(), {
            include: ["support.classify-ticket"],
            remap: {
              "support.summarize-ticket": "operations.summarize-ticket",
            } as never,
          }),
        ],
      }),
    );

    expect(error.issues).toEqual([
      {
        code: "CAPABILITY_REMAP_NOT_SELECTED",
        libraryName: "@community/support-capabilities",
        defaultId: "support.summarize-ticket",
      },
    ]);
  });

  it("orders collision issues before the remaining composition-ordered issues", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: { "support.classify-ticket": plainCapability() },
        imports: [
          importCapabilities(supportLibrary(), {
            include: ["support.unknown" as "support.classify-ticket"],
          }),
          importCapability(plainCapability() as never),
          importCapability(exportedClassify()),
        ],
      }),
    );

    expect(error.issues.map((issue) => issue.code)).toEqual([
      "CAPABILITY_ID_COLLISION",
      "CAPABILITY_IMPORT_ID_NOT_FOUND",
      "CAPABILITY_IMPORT_INVALID",
    ]);
  });

  it("rejects a non-library value passed to importCapabilities", () => {
    expect(() => importCapabilities(plainCapability() as never)).toThrow(
      TypeError,
    );
  });

  it("rejects malformed import options", () => {
    const library = supportLibrary();

    expect(() =>
      importCapability(exportedClassify(), { as: "" as "operations.a" }),
    ).toThrow(TypeError);
    expect(() =>
      importCapabilities(library, {
        include: "support.classify-ticket" as never,
      }),
    ).toThrow(TypeError);
    expect(() =>
      importCapabilities(library, { include: [42 as never] }),
    ).toThrow(TypeError);
    expect(() =>
      importCapabilities(library, {
        remap: { "support.classify-ticket": "" } as never,
      }),
    ).toThrow(TypeError);
  });

  it("rejects a value that is not an import descriptor", () => {
    expect(() =>
      composeUnchecked({ imports: [{ kind: "atomic" } as never] }),
    ).toThrow(TypeError);
  });
});

describe("composition error immutability and detection", () => {
  it("deep freezes the error and its issues", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: { "support.classify-ticket": plainCapability() },
        imports: [importCapability(exportedClassify())],
      }),
    );
    const issue = error.issues[0];

    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(issue)).toBe(true);
    if (issue?.code === "CAPABILITY_ID_COLLISION") {
      expect(Object.isFrozen(issue.declarations)).toBe(true);
      expect(Object.isFrozen(issue.declarations[0])).toBe(true);
      expect(() => {
        (issue.declarations as CapabilityDeclarationProvenance[]).push({
          kind: "local",
          localId: "injected",
        });
      }).toThrow(TypeError);
    }
  });

  it("cannot be mutated to alter a later successful composition", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: { "support.classify-ticket": plainCapability() },
        imports: [importCapability(exportedClassify())],
      }),
    );

    expect(() => {
      (error as unknown as { issues: unknown }).issues = [];
    }).toThrow(TypeError);

    const composed = composeCapabilities({
      local: { "support.classify-ticket": plainCapability() },
    });

    expect(Object.keys(composed)).toEqual(["support.classify-ticket"]);
  });

  it("detects composition errors without instanceof", () => {
    const error = captureCompositionError(() =>
      composeUnchecked({
        local: { "support.classify-ticket": plainCapability() },
        imports: [importCapability(exportedClassify())],
      }),
    );

    expect(isCapabilityCompositionError(error)).toBe(true);
    expect(
      isCapabilityCompositionError({
        code: "CAPABILITY_COMPOSITION_INVALID",
        issues: [],
      }),
    ).toBe(true);
    expect(isCapabilityCompositionError(new TypeError("other"))).toBe(false);
    expect(isCapabilityCompositionError(null)).toBe(false);
    expect(
      isCapabilityCompositionError({
        code: "CAPABILITY_COMPOSITION_INVALID",
        issues: "none",
      }),
    ).toBe(false);
  });
});

describe("composition scale", () => {
  it("validates 10,000 dynamic declarations without recursion or execution", () => {
    const tracked = trackedCapability();
    const local: Record<string, AnyCapability> = {};
    const imports: AnyCapabilityImport[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      local[`local.capability-${index}`] = tracked.capability;
      imports.push(
        importCapability(
          defineExportedCapability({
            source: { name: "@community/generated", version: "1.0.0" },
            defaultId: `imported.capability-${index}`,
            capability: tracked.capability,
          }),
        ),
      );
    }

    const composed = composeUnchecked({ local, imports });

    expect(Object.keys(composed)).toHaveLength(10_000);
    expect(Object.keys(composed)[0]).toBe("local.capability-0");
    expect(Object.keys(composed)[9_999]).toBe("imported.capability-4999");
    expect(tracked.run).not.toHaveBeenCalled();
    expect(tracked.access).not.toHaveBeenCalled();
  });

  it("reports every collision in a 10,000 declaration composition", () => {
    const tracked = trackedCapability();
    const local: Record<string, AnyCapability> = {};
    const imports: AnyCapabilityImport[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      const id = `generated.capability-${String(index).padStart(4, "0")}`;
      local[id] = tracked.capability;
      imports.push(
        importCapability(
          defineExportedCapability({
            source: { name: "@community/generated" },
            defaultId: id,
            capability: tracked.capability,
          }),
        ),
      );
    }

    const error = captureCompositionError(() =>
      composeUnchecked({ local, imports }),
    );

    expect(error.issues).toHaveLength(5_000);
    expect(collisionIds(error)[0]).toBe("generated.capability-0000");
    expect(collisionIds(error)[4_999]).toBe("generated.capability-4999");
    expect(tracked.run).not.toHaveBeenCalled();
    expect(tracked.access).not.toHaveBeenCalled();
  });
});
