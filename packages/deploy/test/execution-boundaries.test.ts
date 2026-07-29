import type { SpawnSyncReturns } from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sourceRoot = join(repositoryRoot, "packages/deploy/src");
const fixtures = new URL("./fixtures/", import.meta.url);

const processSentinel = fileURLToPath(
  new URL("forbid-process-execution.mjs", fixtures),
);
const networkSentinel = fileURLToPath(
  new URL("forbid-network-access.mjs", fixtures),
);
const toolkitScenario = fileURLToPath(
  new URL("toolkit-sentinel-scenario.mjs", fixtures),
);
const probeScenario = fileURLToPath(
  new URL("probe-network-attempt.mjs", fixtures),
);

interface SourceModule {
  /** Package-relative POSIX path, so a failure names the offending module. */
  readonly path: string;
  readonly source: string;
  /** The same text with every comment and template literal blanked out. */
  readonly code: string;
}

const networkBuiltins = [
  "node:dgram",
  "node:dns",
  "node:http",
  "node:http2",
  "node:https",
  "node:net",
  "node:tls",
] as const;

const childProcessMarkers = [
  "node:child_process",
  "execFile",
  "execSync",
  "spawnSync",
  "spawn(",
] as const;

type ScanMode =
  | "code"
  | "line-comment"
  | "block-comment"
  | "single"
  | "double"
  | "template";

/**
 * Blanks every comment and template literal while keeping ordinary string
 * literals, so what remains is the module's own executable text. The scaffold
 * templates carry an engine author's imports as template text; only the
 * toolkit's own imports survive this.
 */
function blankCommentsAndTemplates(source: string): string {
  const out: string[] = [];
  // The brace depth at which each open template resumes after `${ ... }`.
  const templateDepths: number[] = [];
  let mode: ScanMode = "code";
  let braceDepth = 0;
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1];

    if (mode === "code") {
      if (char === "/" && next === "/") {
        mode = "line-comment";
        out.push("  ");
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        mode = "block-comment";
        out.push("  ");
        index += 2;
        continue;
      }
      if (char === "'" || char === '"') {
        mode = char === "'" ? "single" : "double";
        out.push(char);
        index += 1;
        continue;
      }
      if (char === "`") {
        templateDepths.push(braceDepth);
        mode = "template";
        out.push(" ");
        index += 1;
        continue;
      }
      if (char === "{") braceDepth += 1;
      if (char === "}") {
        braceDepth -= 1;
        if (templateDepths.at(-1) === braceDepth) {
          mode = "template";
          out.push(" ");
          index += 1;
          continue;
        }
      }
      out.push(char);
      index += 1;
      continue;
    }

    if (mode === "line-comment") {
      out.push(char === "\n" ? "\n" : " ");
      if (char === "\n") mode = "code";
      index += 1;
      continue;
    }

    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        out.push("  ");
        index += 2;
        continue;
      }
      out.push(char === "\n" ? "\n" : " ");
      index += 1;
      continue;
    }

    if (mode === "single" || mode === "double") {
      out.push(char);
      if (char === "\\") {
        out.push(next ?? "");
        index += 2;
        continue;
      }
      if (mode === "single" ? char === "'" : char === '"') mode = "code";
      index += 1;
      continue;
    }

    if (char === "\\") {
      out.push("  ");
      index += 2;
      continue;
    }
    if (char === "`") {
      templateDepths.pop();
      mode = "code";
      out.push(" ");
      index += 1;
      continue;
    }
    if (char === "$" && next === "{") {
      braceDepth += 1;
      mode = "code";
      out.push("  ");
      index += 2;
      continue;
    }
    out.push(char === "\n" ? "\n" : " ");
    index += 1;
  }

  return out.join("");
}

function collectSourceModules(
  directory: string,
  prefix: string,
): SourceModule[] {
  const modules: SourceModule[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      modules.push(...collectSourceModules(absolute, `${relative}/`));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const source = readFileSync(absolute, "utf8");
    modules.push({
      path: relative,
      source,
      code: blankCommentsAndTemplates(source),
    });
  }
  return modules;
}

const modules = collectSourceModules(sourceRoot, "src/");

// A specifier and its keyword always share a line once the formatter has run,
// so the patterns stay on one line: a run of blanked template text must never
// be bridged into a match.
const specifierPatterns = [
  /\bfrom[ \t]*"([^"\n]*)"/gu,
  /\bimport[ \t]*"([^"\n]*)"/gu,
  /\bimport[ \t]*\([ \t]*"([^"\n]*)"/gu,
  /\brequire[ \t]*\([ \t]*"([^"\n]*)"/gu,
] as const;

function specifiersOf(module: SourceModule): readonly string[] {
  const found: string[] = [];
  for (const pattern of specifierPatterns) {
    for (const match of module.code.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
}

function isLocalOrBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Every `path: marker` pair whose marker survives the template blanking. */
function markersInCode(markers: readonly string[]): readonly string[] {
  return modules.flatMap((module) =>
    markers
      .filter((marker) => module.code.includes(marker))
      .map((marker) => `${module.path}: ${marker}`),
  );
}

describe("the toolkit source scanner", () => {
  it("keeps executable text and blanks comments and template text", () => {
    const scanned = blankCommentsAndTemplates(
      [
        'import { join } from "node:path";',
        '// import bad from "node:child_process";',
        '/* import worse from "node:net"; */',
        'const template = `import evil from "node:dgram";`;',
        `const interpolated = \`a\${join("node:fs")}b\`;`,
      ].join("\n"),
    );

    expect(scanned).toContain('import { join } from "node:path";');
    expect(scanned).not.toContain("node:child_process");
    expect(scanned).not.toContain("node:net");
    expect(scanned).not.toContain("node:dgram");
    // An interpolation is executable text again, so it is still scanned.
    expect(scanned).toContain('join("node:fs")');
  });

  it("finds every module the package ships", () => {
    const paths = modules.map((module) => module.path);

    expect(paths.length).toBeGreaterThan(20);
    for (const required of [
      "src/index.ts",
      "src/cli.ts",
      "src/init.ts",
      "src/package-command.ts",
      "src/probe.ts",
      "src/probe/request.ts",
      "src/scaffold/env-module.ts",
      "src/scaffold/http-root-module.ts",
    ]) {
      expect(paths).toContain(required);
    }
  });

  it("extracts the specifiers a module really imports, and only those", () => {
    const specifiersAt = (path: string): readonly string[] => {
      const module = modules.find((candidate) => candidate.path === path);
      if (module === undefined) throw new Error(`no module at ${path}`);
      return [...specifiersOf(module)].sort();
    };

    expect(specifiersAt("src/probe/request.ts")).toEqual([
      "../probe-contract.js",
      "./options.js",
      "node:http",
      "node:http",
      "node:https",
    ]);
    expect(specifiersAt("src/init.ts")).toContain("node:fs/promises");
    // The loader template imports three built-ins as text and the module that
    // holds it imports nothing at all.
    expect(specifiersAt("src/scaffold/env-module.ts")).toEqual([]);
  });
});

describe("the toolkit import graph", () => {
  it("imports nothing but Node built-ins and its own modules", () => {
    const foreign = modules.flatMap((module) =>
      specifiersOf(module)
        .filter((specifier) => !isLocalOrBuiltin(specifier))
        .map((specifier) => `${module.path}: ${specifier}`),
    );

    expect(foreign).toEqual([]);
  });

  it("declares no runtime dependency of any kind", async () => {
    const namespace = (await import("../package.json", {
      with: { type: "json" },
    })) as { readonly default: Readonly<Record<string, unknown>> };

    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "bundledDependencies",
    ]) {
      expect(namespace.default[field]).toBeUndefined();
    }
  });

  it("mentions a framework package only as scaffold template text", () => {
    const mentioning = modules.filter(
      (module) => occurrences(module.source, "@ai-engine/") > 0,
    );

    expect(mentioning.map((module) => module.path)).toEqual([
      "src/scaffold/auth-module.ts",
      "src/scaffold/http-root-module.ts",
    ]);
    // Every occurrence disappears with the template text, so not one of them is
    // an import the toolkit itself performs.
    expect(markersInCode(["@ai-engine/"])).toEqual([]);
  });

  it("never reaches a child-process entry point", () => {
    expect(markersInCode(childProcessMarkers)).toEqual([]);
  });

  it("reaches a network built-in only from the probe request module", () => {
    const reaching = modules
      .filter((module) =>
        networkBuiltins.some((builtin) => module.code.includes(builtin)),
      )
      .map((module) => module.path);

    expect(reaching).toEqual(["src/probe/request.ts"]);
    expect(markersInCode(["fetch(", "new WebSocket"])).toEqual([]);
  });
});

function runNode(args: readonly string[]): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, [...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: 60_000,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

interface SentinelReport {
  readonly initExitCode: number;
  readonly initFiles: readonly string[];
  readonly packageExitCode: number;
  readonly packageFiles: readonly string[];
  readonly probeExitCodes: readonly number[];
  readonly processAttempts: readonly string[];
  readonly networkAttempts: readonly string[];
  readonly stdout: string;
}

const violationProbes = [
  [
    "a spawn",
    processSentinel,
    'const m = await import("node:child_process"); m.default.spawnSync("true");',
    "DEPLOY_PROCESS_EXECUTION_FORBIDDEN",
  ],
  [
    "a fetch",
    networkSentinel,
    'await fetch("https://example.invalid");',
    "DEPLOY_NETWORK_ACCESS_FORBIDDEN",
  ],
  [
    "a socket",
    networkSentinel,
    'const m = await import("node:net"); m.default.connect(80, "example.invalid");',
    "DEPLOY_NETWORK_ACCESS_FORBIDDEN",
  ],
] as const;

describe("the toolkit runtime sentinels", () => {
  beforeAll(() => {
    // The sentinels are process-level preloads, so they observe the built
    // package exactly as it is published rather than a transformed source graph.
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-b",
        "packages/deploy",
        "--pretty",
        "false",
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
  }, 180_000);

  it("runs init, package, and every probe rejection with no spawn and no connection", () => {
    const result = runNode([
      "--import",
      processSentinel,
      "--import",
      networkSentinel,
      toolkitScenario,
    ]);

    expect(result.stderr).not.toContain("_FORBIDDEN");
    expect(result.stderr).not.toContain("SENTINEL_VIOLATION");
    expect(result.status).toBe(0);

    const report = JSON.parse(result.stdout) as SentinelReport;
    expect(report.processAttempts).toEqual([]);
    expect(report.networkAttempts).toEqual([]);
    expect(report.initExitCode).toBe(0);
    expect([...report.initFiles]).toEqual([
      ".env.example",
      "ai-engine.deploy.json",
      "src",
    ]);
    expect(report.packageExitCode).toBe(0);
    for (const generated of ["Dockerfile", ".dockerignore", "deploy"]) {
      expect(report.packageFiles).toContain(generated);
    }
    expect(report.probeExitCodes.length).toBeGreaterThanOrEqual(10);
    expect(report.probeExitCodes.every((code) => code === 2)).toBe(true);
    // Neither command may write to stdout, sentinels or not.
    expect(report.stdout).toBe("");
  }, 120_000);

  it("still sees the probe transport, so an empty attempt list is not vacuous", () => {
    const result = runNode(["--import", networkSentinel, probeScenario]);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      readonly exitCode: number;
      readonly networkAttempts: readonly string[];
    };
    expect(report.networkAttempts.length).toBeGreaterThan(0);
    expect(report.exitCode).not.toBe(0);
  }, 60_000);

  it.each(violationProbes)(
    "refuses %s under the sentinel it belongs to",
    (_label, sentinel, probe, marker) => {
      const result = runNode([
        "--import",
        sentinel,
        "--input-type=module",
        "--eval",
        probe,
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(marker);
    },
  );
});
