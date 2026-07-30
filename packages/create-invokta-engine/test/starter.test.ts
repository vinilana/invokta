import { describe, expect, it } from "vitest";

import { createStarterFiles } from "../src/starter.js";

const expectedPaths = [
  ".agents/skills/develop-invokta-project/SKILL.md",
  ".agents/skills/develop-invokta-project/agents/openai.yaml",
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "invokta.mcp.json",
  "package.json",
  "src/capabilities/create-welcome-message.ts",
  "src/cli.ts",
  "src/direct.ts",
  "src/engine.ts",
  "src/mcp-stdio.ts",
  "test/engine.test.ts",
  "tsconfig.json",
  "tsconfig.test.json",
] as const;

describe("createStarterFiles", () => {
  it("renders the fixed standalone starter in lexicographic path order", () => {
    const files = createStarterFiles({
      projectName: "customer-support-engine",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
    });

    expect(files.map((file) => file.path)).toEqual(expectedPaths);
    expect(files).toEqual(
      createStarterFiles({
        projectName: "customer-support-engine",
        invoktaVersion: "1.2.3",
        packageManager: "npm",
      }),
    );
    for (const file of files) {
      if (!("contents" in file)) continue;
      expect(file.contents).not.toContain("\r");
      expect(file.contents).not.toContain("\u0000");
      expect(file.contents.endsWith("\n")).toBe(true);
      expect(file.contents.endsWith("\n\n")).toBe(false);
    }
  });

  it("scaffolds a focused Action Engine development skill", () => {
    const files = createStarterFiles({
      projectName: "customer-support-engine",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
    });
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
    const files = createStarterFiles({
      projectName: "customer-support-engine",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
    });
    const instructions = files.find((file) => file.path === "AGENTS.md");

    expect(instructions).toMatchObject({ kind: "file", path: "AGENTS.md" });
    expect(
      instructions && "contents" in instructions ? instructions.contents : "",
    ).toContain(
      "Keep direct, CLI, and MCP entry points on the single `engine.invoke` path.",
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
        "@invokta/mcp": "1.2.3-beta.1",
        zod: "4.4.3",
      },
      devDependencies: {
        "@invokta/installer": "1.2.3-beta.1",
        "@types/node": "26.1.2",
        typescript: "7.0.2",
        vitest: "4.1.10",
      },
    });
  });

  it("declares a deterministic local MCP installation source", () => {
    const files = createStarterFiles({
      projectName: "customer-support-engine",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
    });
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
    const files = createStarterFiles({
      projectName: "customer-support-engine",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
    });
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
    expect([...contents.keys()]).not.toContain("src/mcp-http.ts");
  });

  it.each([
    ["npm", "npm run check"],
    ["pnpm", "pnpm run check"],
    ["yarn", "yarn run check"],
  ] as const)(
    "renders %s commands in the generated README",
    (manager, command) => {
      const files = createStarterFiles({
        projectName: "customer-support-engine",
        invoktaVersion: "1.2.3",
        packageManager: manager,
      });

      const readme = files.find((file) => file.path === "README.md");
      expect(readme && "contents" in readme ? readme.contents : "").toContain(
        command,
      );
    },
  );
});
