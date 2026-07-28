import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  composeCapabilities,
  createEngine,
  importCapability,
  isComposedCapabilities,
  type Principal,
} from "@ai-engine/core";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import { createDependencies } from "./dependencies.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const builtAtomicModule = new URL("../dist/classify-ticket.js", import.meta.url)
  .href;
const principal: Principal = { id: "agent:atomic" };

beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    ["../../node_modules/typescript/bin/tsc", "-b", "--pretty", "false"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(`Fixture build failed:\n${build.stdout}${build.stderr}`);
  }
});

async function loadBuiltAtomicModule(): Promise<
  typeof import("../src/classify-ticket.js")
> {
  return (await import(
    builtAtomicModule
  )) as typeof import("../src/classify-ticket.js");
}

describe("the atomic capability published by a built ESM module", () => {
  it("composes and runs from a relative built module without defining a library", async () => {
    const builtModule = await loadBuiltAtomicModule();
    const dependencies = createDependencies();
    const exported = builtModule.createClassifyTicketExport(dependencies);

    expect(Object.keys(builtModule)).toEqual(["createClassifyTicketExport"]);
    expect(exported.defaultId).toBe("community.classify-ticket");
    expect(exported.source).toEqual({
      name: "@ai-engine/example-community-capabilities/classify-ticket",
      version: "1.4.0",
    });
    expectTypeOf(
      exported.defaultId,
    ).toEqualTypeOf<"community.classify-ticket">();

    const capabilities = composeCapabilities({
      imports: [importCapability(exported)],
    });

    expect(isComposedCapabilities(capabilities)).toBe(true);
    expect(Object.keys(capabilities)).toEqual(["community.classify-ticket"]);

    const engine = createEngine({
      name: "atomic-export-smoke-engine",
      version: "0.0.0-test",
      capabilities,
    });
    const result = await engine.invoke(
      "community.classify-ticket",
      { ticketId: "T-123" },
      { source: "direct", principal },
    );

    expect(result).toEqual({
      category: "billing",
      confidence: 0.98,
      rationale: "The ticket reports a duplicate charge.",
    });
    expect(dependencies.permissions.can).toHaveBeenCalledExactlyOnceWith(
      principal,
      "ticket:classify",
      "T-123",
    );
    expect(dependencies.knowledge.search).not.toHaveBeenCalled();
  });

  it("registers only the effective ID when the built module is remapped with as", async () => {
    const builtModule = await loadBuiltAtomicModule();
    const exported = builtModule.createClassifyTicketExport(
      createDependencies(),
    );

    const capabilities = composeCapabilities({
      imports: [importCapability(exported, { as: "operations.triage" })],
    });
    const engine = createEngine({
      name: "atomic-export-remap-engine",
      version: "0.0.0-test",
      capabilities,
    });

    expect(engine.list().map((summary) => summary.id)).toEqual([
      "operations.triage",
    ]);
    await expect(
      engine.invoke(
        // @ts-expect-error The default ID is replaced, not aliased, by `as`.
        "community.classify-ticket",
        { ticketId: "T-123" },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_FOUND" });
  });
});
