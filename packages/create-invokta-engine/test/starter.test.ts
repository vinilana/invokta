import { describe, expect, it } from "vitest";

import { createStarterFiles } from "../src/starter.js";

const expectedPaths = [
  ".gitignore",
  "README.md",
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
      expect(file.contents).not.toContain("\r");
      expect(file.contents).not.toContain("\u0000");
      expect(file.contents.endsWith("\n")).toBe(true);
      expect(file.contents.endsWith("\n\n")).toBe(false);
    }
  });

  it("pins Invokta packages to the creator version in a private ESM project", () => {
    const files = createStarterFiles({
      projectName: "customer-support-engine",
      invoktaVersion: "1.2.3-beta.1",
      packageManager: "npm",
    });
    const manifestFile = files.find((file) => file.path === "package.json");
    const manifest = JSON.parse(manifestFile?.contents ?? "") as Record<
      string,
      unknown
    >;

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
        "@types/node": "26.1.2",
        typescript: "7.0.2",
        vitest: "4.1.10",
      },
    });
  });

  it("uses one public capability through direct, CLI, and MCP stdio entry points", () => {
    const files = createStarterFiles({
      projectName: "customer-support-engine",
      invoktaVersion: "1.2.3",
      packageManager: "npm",
    });
    const contents = new Map(files.map((file) => [file.path, file.contents]));

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
    ["yarn", "yarn check"],
  ] as const)(
    "renders %s commands in the generated README",
    (manager, command) => {
      const files = createStarterFiles({
        projectName: "customer-support-engine",
        invoktaVersion: "1.2.3",
        packageManager: manager,
      });

      expect(
        files.find((file) => file.path === "README.md")?.contents,
      ).toContain(command);
    },
  );
});
