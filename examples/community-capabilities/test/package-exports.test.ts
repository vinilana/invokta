import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  composeCapabilities,
  createEngine,
  importCapabilities,
  importCapability,
  type Principal,
} from "@ai-engine/core";
import { beforeAll, describe, expect, it } from "vitest";

import { createDependencies } from "./dependencies.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const distUrl = new URL("../dist/", import.meta.url);
const principal: Principal = { id: "agent:resolution" };

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

function runNodeModule(source: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

/**
 * The emitted ESM is the artifact Node evaluates, so the check walks the static
 * import graph of the built files instead of trusting the TypeScript sources.
 */
const staticSpecifier =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/gu;

async function readModuleGraph(entry: string): Promise<{
  readonly modules: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<string>;
}> {
  const visited = new Set<string>();
  const sources: string[] = [];
  const pending = [new URL(entry, distUrl).href];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    const source = await readFile(new URL(current), "utf8");
    sources.push(source);
    for (const match of source.matchAll(staticSpecifier)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      pending.push(new URL(specifier, current).href);
    }
  }
  return {
    modules: [...visited]
      .map((href) => href.slice(distUrl.href.length))
      .sort((left, right) => (left < right ? -1 : 1)),
    sources,
  };
}

describe("the fixture package exports map", () => {
  it("resolves the root, the atomic subpath, and the library subpath through Node", () => {
    const resolved = runNodeModule(
      `process.stdout.write(JSON.stringify([
        "@ai-engine/example-community-capabilities",
        "@ai-engine/example-community-capabilities/classify-ticket",
        "@ai-engine/example-community-capabilities/library",
      ].map((specifier) => import.meta.resolve(specifier))));`,
    );

    expect(resolved.stderr).toBe("");
    expect(resolved.status).toBe(0);
    expect(
      (JSON.parse(resolved.stdout) as ReadonlyArray<string>).map((href) =>
        href.slice(href.indexOf("/dist/")),
      ),
    ).toEqual([
      "/dist/index.js",
      "/dist/classify-ticket.js",
      "/dist/library.js",
    ]);
  });

  it("publishes an atomic capability from the package root and from the atomic subpath", async () => {
    const root = await import("@ai-engine/example-community-capabilities");
    const subpath = await import(
      "@ai-engine/example-community-capabilities/classify-ticket"
    );
    const dependencies = createDependencies();

    const capabilities = composeCapabilities({
      imports: [
        importCapability(root.createScoreTicketPriorityExport(dependencies)),
        importCapability(subpath.createClassifyTicketExport(dependencies)),
      ],
    });

    expect(Object.keys(capabilities)).toEqual([
      "community.score-ticket-priority",
      "community.classify-ticket",
    ]);

    const engine = createEngine({
      name: "package-resolution-engine",
      version: "0.0.0-test",
      capabilities,
    });

    await expect(
      engine.invoke(
        "community.score-ticket-priority",
        { ticketId: "T-123" },
        { source: "direct", principal },
      ),
    ).resolves.toEqual({
      priority: "normal",
      weight: 1,
      signals: ["invoice"],
    });
    await expect(
      engine.invoke(
        "community.classify-ticket",
        { ticketId: "T-123" },
        { source: "direct", principal },
      ),
    ).resolves.toMatchObject({ category: "billing" });
  });

  it("evaluates the atomic subpath without loading the library bundle", async () => {
    const subpathGraph = await readModuleGraph("classify-ticket.js");
    const rootGraph = await readModuleGraph("index.js");

    expect(subpathGraph.modules).toEqual([
      "capabilities/classify-ticket.js",
      "classify-ticket.js",
    ]);
    expect(subpathGraph.modules).not.toContain("library.js");
    expect(rootGraph.modules).not.toContain("library.js");
    for (const source of subpathGraph.sources) {
      expect(source).not.toMatch(/\bimport\s*\(/u);
    }

    const evaluated = runNodeModule(
      `const atomic = await import(
        "@ai-engine/example-community-capabilities/classify-ticket",
      );
      process.stdout.write(JSON.stringify(Object.keys(atomic)));`,
    );

    expect(evaluated.stderr).toBe("");
    expect(evaluated.status).toBe(0);
    expect(JSON.parse(evaluated.stdout)).toEqual([
      "createClassifyTicketExport",
    ]);
  });

  it("publishes the capability library only from the library subpath", async () => {
    const library = await import(
      "@ai-engine/example-community-capabilities/library"
    );
    const bundle = library.createCommunitySupportLibrary(createDependencies());

    expect(bundle.name).toBe(
      "@ai-engine/example-community-capabilities/library",
    );
    expect(bundle.version).toBe("1.4.0");

    const capabilities = composeCapabilities({
      imports: [importCapabilities(bundle)],
    });

    expect(Object.keys(capabilities)).toEqual([
      "community.summarize-thread",
      "community.search-knowledge-base",
      "community.draft-reply",
    ]);
  });
});
