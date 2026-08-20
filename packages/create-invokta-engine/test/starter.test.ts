import { readFileSync } from "node:fs";
import {
  createMcpHttpScaffoldFiles,
  starterDeployManifest,
} from "@invokta/deploy/scaffold";
import { describe, expect, it } from "vitest";

import {
  createStarterFiles,
  type EngineStarterProfile,
} from "../src/starter.js";

const commonPaths = [
  ".agents/skills/develop-invokta-project/SKILL.md",
  ".agents/skills/develop-invokta-project/agents/openai.yaml",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "src/capabilities/create-welcome-message.ts",
  "src/direct.ts",
  "src/engine.ts",
  "test/engine.test.ts",
  "tsconfig.json",
  "tsconfig.test.json",
] as const;

const expectedPaths = {
  complete: [
    ...commonPaths,
    ".env.example",
    "invokta.deploy.json",
    "invokta.mcp.json",
    "src/bin.ts",
    "src/cli.ts",
    "src/env.ts",
    "src/http-auth.ts",
    "src/mcp-http.ts",
    "src/mcp-stdio.ts",
  ].sort(),
  "mcp-stdio": [
    ...commonPaths,
    "invokta.mcp.json",
    "src/bin.ts",
    "src/mcp-stdio.ts",
  ].sort(),
  "mcp-http": [
    ...commonPaths,
    ".env.example",
    "invokta.deploy.json",
    "src/env.ts",
    "src/http-auth.ts",
    "src/mcp-http.ts",
  ].sort(),
  cli: [...commonPaths, "src/cli.ts"].sort(),
} as const satisfies Readonly<Record<EngineStarterProfile, readonly string[]>>;

function createFiles(
  profile: EngineStarterProfile = "complete",
  packageManager: "npm" | "pnpm" | "yarn" = "npm",
) {
  return createStarterFiles({
    projectName: "customer-support-engine",
    invoktaVersion: "1.2.3",
    packageManager,
    profile,
  });
}

describe("createStarterFiles", () => {
  it.each(Object.entries(expectedPaths) as [EngineStarterProfile, string[]][])(
    "renders the exact %s starter in lexicographic path order",
    (profile, paths) => {
      const files = createFiles(profile);

      expect(files.map((file) => file.path)).toEqual(paths);
      expect(files).toEqual(createFiles(profile));
      expect(Object.isFrozen(files)).toBe(true);
      expect(files.every((file) => Object.isFrozen(file))).toBe(true);
      for (const file of files) {
        if (!("contents" in file)) continue;
        expect(file.contents).not.toContain("\r");
        expect(file.contents).not.toContain("\u0000");
        expect(file.contents.endsWith("\n")).toBe(true);
        expect(file.contents.endsWith("\n\n")).toBe(false);
      }
    },
  );

  it("uses byte-identical deploy-owned HTTP entries", () => {
    const expected = createMcpHttpScaffoldFiles(starterDeployManifest);

    for (const profile of ["complete", "mcp-http"] as const) {
      const actual = createFiles(profile);
      for (const file of expected) {
        expect(actual.find((entry) => entry.path === file.path)).toEqual({
          kind: "file",
          ...file,
        });
      }
    }
  });

  it("consumes only the public deploy scaffold subpath", () => {
    const source = readFileSync(
      new URL("../src/starter.ts", import.meta.url),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };

    expect(source).toContain('from "@invokta/deploy/scaffold"');
    expect(source).not.toContain("packages/deploy/src");
    expect(source).not.toContain("../deploy/");
    expect(manifest.dependencies).toEqual({
      "@invokta/deploy": "0.6.1",
      tar: "7.5.22",
    });
  });

  it.each([
    [
      "complete",
      [
        "@invokta/cli",
        "@invokta/core",
        "@invokta/installer",
        "@invokta/mcp",
        "zod",
      ],
      [
        "@invokta/deploy",
        "@invokta/devtools",
        "@invokta/tooling",
        "@types/node",
        "typescript",
        "vitest",
      ],
      [
        "build",
        "check",
        "check:mcp",
        "cli",
        "deploy:package",
        "deploy:probe",
        "devtools",
        "devtools:doctor",
        "direct",
        "mcp:http",
        "mcp:install",
        "mcp:stdio",
        "mcp:uninstall",
        "test",
        "typecheck",
      ],
    ],
    [
      "mcp-stdio",
      ["@invokta/core", "@invokta/installer", "@invokta/mcp", "zod"],
      [
        "@invokta/devtools",
        "@invokta/tooling",
        "@types/node",
        "typescript",
        "vitest",
      ],
      [
        "build",
        "check",
        "check:mcp",
        "devtools",
        "devtools:doctor",
        "direct",
        "mcp:install",
        "mcp:stdio",
        "mcp:uninstall",
        "test",
        "typecheck",
      ],
    ],
    [
      "mcp-http",
      ["@invokta/core", "@invokta/mcp", "zod"],
      [
        "@invokta/deploy",
        "@invokta/devtools",
        "@invokta/tooling",
        "@types/node",
        "typescript",
        "vitest",
      ],
      [
        "build",
        "check",
        "check:mcp",
        "deploy:package",
        "deploy:probe",
        "devtools",
        "devtools:doctor",
        "direct",
        "mcp:http",
        "test",
        "typecheck",
      ],
    ],
    [
      "cli",
      ["@invokta/cli", "@invokta/core", "zod"],
      ["@invokta/devtools", "@types/node", "typescript", "vitest"],
      [
        "build",
        "check",
        "cli",
        "devtools",
        "devtools:doctor",
        "direct",
        "test",
        "typecheck",
      ],
    ],
  ] as const)(
    "renders only the dependencies and scripts required by %s",
    (profile, dependencies, devDependencies, scripts) => {
      const packageFile = createFiles(profile).find(
        (file) => file.path === "package.json",
      );
      const manifest = JSON.parse(
        packageFile && "contents" in packageFile ? packageFile.contents : "",
      ) as {
        readonly dependencies: Readonly<Record<string, string>>;
        readonly devDependencies: Readonly<Record<string, string>>;
        readonly scripts: Readonly<Record<string, string>>;
      };

      expect(Object.keys(manifest.dependencies).sort()).toEqual(dependencies);
      expect(Object.keys(manifest.devDependencies).sort()).toEqual(
        devDependencies,
      );
      expect(Object.keys(manifest.scripts).sort()).toEqual(scripts);
      for (const [name, version] of Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })) {
        if (name.startsWith("@invokta/")) expect(version).toBe("1.2.3");
      }
    },
  );

  it.each(["complete", "mcp-stdio", "mcp-http", "cli"] as const)(
    "adds only the explicit devtools commands to the %s profile",
    (profile) => {
      const packageFile = createFiles(profile).find(
        (file) => file.path === "package.json",
      );
      const manifest = JSON.parse(
        packageFile && "contents" in packageFile ? packageFile.contents : "",
      ) as {
        readonly scripts: Readonly<Record<string, string>>;
      };
      const serveCommand =
        'tsc -p tsconfig.json --pretty false && invokta-devtools serve dist/engine.js --watch --build "tsc -p tsconfig.json --pretty false"';

      expect(manifest.scripts.dev).toBeUndefined();
      expect(manifest.scripts.devtools).toBe(serveCommand);
      expect(manifest.scripts["devtools:doctor"]).toBe(
        "tsc -p tsconfig.json --pretty false && invokta-devtools doctor dist/engine.js",
      );
    },
  );

  it.each(["complete", "mcp-stdio", "mcp-http"] as const)(
    "runs MCP catalog conformance from the generated %s check",
    (profile) => {
      const packageFile = createFiles(profile).find(
        (file) => file.path === "package.json",
      );
      const manifest = JSON.parse(
        packageFile && "contents" in packageFile ? packageFile.contents : "",
      ) as {
        readonly devDependencies: Readonly<Record<string, string>>;
        readonly scripts: Readonly<Record<string, string>>;
      };

      expect(manifest.devDependencies["@invokta/tooling"]).toBe("1.2.3");
      expect(manifest.scripts["check:mcp"]).toBe(
        "invokta check-mcp ./dist/engine.js",
      );
      expect(manifest.scripts.check).toContain(
        "tsc -p tsconfig.json --pretty false && invokta check-mcp ./dist/engine.js",
      );
    },
  );

  it("does not add MCP conformance tooling to the CLI-only profile", () => {
    const packageFile = createFiles("cli").find(
      (file) => file.path === "package.json",
    );
    const manifest = JSON.parse(
      packageFile && "contents" in packageFile ? packageFile.contents : "",
    ) as {
      readonly devDependencies: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };

    expect(manifest.devDependencies["@invokta/tooling"]).toBeUndefined();
    expect(manifest.scripts["check:mcp"]).toBeUndefined();
    expect(manifest.scripts.check).not.toContain("check-mcp");
  });

  it("documents MCP preflight only for profiles that publish MCP tools", () => {
    for (const profile of Object.keys(
      expectedPaths,
    ) as EngineStarterProfile[]) {
      const readme = createFiles(profile).find(
        (file) => file.path === "README.md",
      );
      const contents = readme && "contents" in readme ? readme.contents : "";

      expect(contents.includes("validates its final MCP tool catalog")).toBe(
        profile !== "cli",
      );
    }
  });

  it.each([
    ["cli", ["MCP", "mcp:", "serveMcp"]],
    ["mcp-stdio", ["CLI", "MCP HTTP", "serveMcpHttp", "deploy:"]],
    [
      "mcp-http",
      ["CLI", "MCP local", "MCP stdio", "serveMcpStdio", "mcp:install"],
    ],
  ] as const)(
    "does not advertise omitted adapters in the %s profile",
    (profile, omittedVocabulary) => {
      const documents = createFiles(profile)
        .filter((file) =>
          [
            "README.md",
            "AGENTS.md",
            ".agents/skills/develop-invokta-project/SKILL.md",
          ].includes(file.path),
        )
        .flatMap((file) => ("contents" in file ? [file.contents] : []))
        .join("\n");

      for (const token of omittedVocabulary) {
        expect(documents).not.toContain(token);
      }
    },
  );

  it("ships an embedded installer binary only with MCP stdio profiles", () => {
    for (const profile of Object.keys(
      expectedPaths,
    ) as EngineStarterProfile[]) {
      const files = createFiles(profile);
      const contents = new Map(
        files.flatMap((file) =>
          "contents" in file ? [[file.path, file.contents] as const] : [],
        ),
      );
      const manifest = JSON.parse(contents.get("package.json") ?? "") as {
        readonly bin?: Readonly<Record<string, string>>;
        readonly files?: readonly string[];
      };
      const hasStdio = profile === "complete" || profile === "mcp-stdio";

      expect(contents.has("src/bin.ts")).toBe(hasStdio);
      if (!hasStdio) {
        expect(manifest.bin).toBeUndefined();
        expect(manifest.files).toBeUndefined();
        continue;
      }
      expect(manifest.bin).toEqual({
        "customer-support-engine": "./dist/bin.js",
      });
      expect(manifest.files).toEqual(["dist", "invokta.mcp.json"]);
      const binModule = contents.get("src/bin.ts") ?? "";
      expect(binModule.startsWith("#!/usr/bin/env node\n")).toBe(true);
      expect(binModule).toContain(
        'import { runEngineInstallerCli } from "@invokta/installer/engine";',
      );
      expect(binModule).toContain('binaryName: "customer-support-engine"');
      expect(binModule).toContain(
        'packageRoot: fileURLToPath(new URL("..", import.meta.url))',
      );
    }
  });

  it("uses one shared engine through every entry point included by a profile", () => {
    for (const profile of Object.keys(
      expectedPaths,
    ) as EngineStarterProfile[]) {
      const contents = new Map(
        createFiles(profile).flatMap((file) =>
          "contents" in file ? [[file.path, file.contents] as const] : [],
        ),
      );
      expect(contents.get("src/direct.ts")).toContain("engine.invoke(");
      if (profile === "complete" || profile === "cli") {
        expect(contents.get("src/cli.ts")).toContain("runCli(engine");
      }
      if (profile === "complete" || profile === "mcp-stdio") {
        expect(contents.get("src/mcp-stdio.ts")).toContain(
          "serveMcpStdio(engine",
        );
      }
      if (profile === "complete" || profile === "mcp-http") {
        expect(contents.get("src/mcp-http.ts")).toContain(
          "serveMcpHttp(engine",
        );
      }
    }
  });

  it("uses an HTTP-safe gitignore only for HTTP profiles", () => {
    for (const profile of Object.keys(
      expectedPaths,
    ) as EngineStarterProfile[]) {
      const gitignore = createFiles(profile).find(
        (file) => file.path === ".gitignore",
      );
      const contents =
        gitignore && "contents" in gitignore ? gitignore.contents : "";
      const hasHttp = profile === "complete" || profile === "mcp-http";
      expect(contents.includes(".env\n")).toBe(hasHttp);
      expect(contents.includes(".env.*\n")).toBe(hasHttp);
      expect(contents.includes("!.env.example\n")).toBe(hasHttp);
    }
  });

  it("keeps every generated text entry deterministic", () => {
    const files = createFiles();
    for (const file of files) {
      if (!("contents" in file)) continue;
      expect(file.contents).not.toContain("\r");
      expect(file.contents).not.toContain("\u0000");
      expect(file.contents.endsWith("\n")).toBe(true);
      expect(file.contents.endsWith("\n\n")).toBe(false);
    }
  });

  it("scaffolds a focused Action Engine development skill", () => {
    const files = createFiles();
    const contents = new Map(
      files.flatMap((file) =>
        "contents" in file ? [[file.path, file.contents] as const] : [],
      ),
    );
    const skill =
      contents.get(".agents/skills/develop-invokta-project/SKILL.md") ?? "";
    const metadata =
      contents.get(
        ".agents/skills/develop-invokta-project/agents/openai.yaml",
      ) ?? "";

    expect(skill).toMatch(
      /^---\nname: develop-invokta-project\ndescription: .+\n---\n/u,
    );
    expect(skill).toContain("Keep every execution channel on `engine.invoke`");
    expect(skill).toContain("Run `npm run check`");
    expect(skill).not.toContain("TODO");
    expect(metadata).toContain('display_name: "Develop Invokta Action Engine"');
    expect(metadata).toContain("$develop-invokta-project");
  });

  it("uses one agent-instruction file through a relative Claude alias", () => {
    const files = createFiles();
    const instructions = files.find((file) => file.path === "AGENTS.md");

    expect(instructions).toMatchObject({ kind: "file", path: "AGENTS.md" });
    expect(
      instructions && "contents" in instructions ? instructions.contents : "",
    ).toContain(
      "Keep the generated direct, CLI, MCP stdio, MCP HTTP entry points on the single `engine.invoke` path.",
    );
    expect(files.find((file) => file.path === "CLAUDE.md")).toEqual({
      kind: "symlink",
      path: "CLAUDE.md",
      target: "AGENTS.md",
    });
  });

  it("pins Invokta packages to the creator version in a private ESM project", () => {
    const files = createStarterFiles({
      projectName: "customer-support-engine",
      invoktaVersion: "1.2.3-beta.1",
      packageManager: "npm",
      profile: "complete",
    });
    const manifestFile = files.find((file) => file.path === "package.json");
    const manifest = JSON.parse(
      manifestFile && "contents" in manifestFile ? manifestFile.contents : "",
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      name: "customer-support-engine",
      version: "0.1.0",
      private: true,
      type: "module",
      engines: { node: ">=22.20.0" },
      dependencies: {
        "@invokta/cli": "1.2.3-beta.1",
        "@invokta/core": "1.2.3-beta.1",
        "@invokta/installer": "1.2.3-beta.1",
        "@invokta/mcp": "1.2.3-beta.1",
        zod: "4.4.3",
      },
      devDependencies: {
        "@types/node": "26.1.2",
        typescript: "7.0.2",
        vitest: "^4.1.10",
      },
    });
  });

  it("declares a deterministic local MCP installation source", () => {
    const files = createFiles();
    const contents = new Map(
      files.flatMap((file) =>
        "contents" in file ? [[file.path, file.contents] as const] : [],
      ),
    );
    const packageManifest = JSON.parse(contents.get("package.json") ?? "") as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    expect(packageManifest.scripts["mcp:install"]).toBe(
      "tsc -p tsconfig.json --pretty false && invokta-installer install --engine .",
    );
    expect(packageManifest.scripts["mcp:uninstall"]).toBe(
      "invokta-installer remove --engine .",
    );
    expect(JSON.parse(contents.get("invokta.mcp.json") ?? "")).toEqual({
      schemaVersion: 1,
      id: "customer-support-engine",
      version: "0.1.0",
      title: "customer-support-engine",
      description: "MCP access to the customer-support-engine Action Engine.",
      capabilityIds: ["onboarding.create-welcome-message"],
      server: {
        name: "customer-support-engine",
        entrypoint: "dist/mcp-stdio.js",
        forwardEnv: [],
      },
    });
  });

  it("uses one public capability through direct, CLI, and MCP stdio entry points", () => {
    const files = createFiles();
    const contents = new Map(
      files.flatMap((file) =>
        "contents" in file ? [[file.path, file.contents] as const] : [],
      ),
    );

    expect(
      contents.get("src/capabilities/create-welcome-message.ts"),
    ).toContain('access: "public"');
    expect(contents.get("src/engine.ts")).toContain(
      '"onboarding.create-welcome-message": createWelcomeMessage',
    );
    expect(contents.get("src/engine.ts")).toContain(
      'name: "customer-support-engine"',
    );
    expect(contents.get("src/direct.ts")).toContain("engine.invoke(");
    expect(contents.get("src/cli.ts")).toContain("runCli(engine");
    expect(contents.get("src/mcp-stdio.ts")).toContain("serveMcpStdio(engine");
    expect(contents.get("src/mcp-http.ts")).toContain("serveMcpHttp(engine");
  });

  it.each([
    [
      "npm",
      "npm run check",
      "npm run devtools",
      "npm run devtools:doctor",
      "npm run dev",
      "npm run mcp:install",
      "npm run mcp:uninstall",
    ],
    [
      "pnpm",
      "pnpm run check",
      "pnpm run devtools",
      "pnpm run devtools:doctor",
      "pnpm run dev",
      "pnpm run mcp:install",
      "pnpm run mcp:uninstall",
    ],
    [
      "yarn",
      "yarn run check",
      "yarn devtools",
      "yarn devtools:doctor",
      "yarn dev",
      "yarn mcp:install",
      "yarn mcp:uninstall",
    ],
  ] as const)(
    "renders %s commands in the generated README",
    (manager, check, devtools, doctor, legacyDev, install, uninstall) => {
      const files = createFiles("complete", manager);

      const readme = files.find((file) => file.path === "README.md");
      const contents = readme && "contents" in readme ? readme.contents : "";
      expect(contents).toContain(check);
      expect(contents).toContain(devtools);
      expect(contents).toContain(doctor);
      expect(contents).toContain("switch test identities");
      expect(contents).not.toContain("development principals");
      expect(contents).not.toContain(`\`${legacyDev}\``);
      expect(contents).toContain(install);
      expect(contents).toContain(uninstall);
    },
  );
});
