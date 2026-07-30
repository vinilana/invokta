import {
  type PackageManager,
  packageManagerCommands,
} from "./package-manager.js";

export type StarterEntry =
  | Readonly<{
      kind: "file";
      /** Project-relative POSIX path. */
      path: string;
      contents: string;
    }>
  | Readonly<{
      kind: "symlink";
      /** Project-relative POSIX path. */
      path: string;
      /** Project-relative symbolic-link target. */
      target: string;
    }>;

export interface CreateStarterFilesOptions {
  readonly projectName: string;
  readonly invoktaVersion: string;
  readonly packageManager: PackageManager;
}

function renderReadme(
  projectName: string,
  packageManager: PackageManager,
): string {
  const commands = packageManagerCommands[packageManager];
  const runScript = (name: string) =>
    packageManager === "yarn"
      ? `yarn ${name}`
      : `${packageManager} run ${name}`;
  return `# ${projectName}

A standalone [Invokta](https://docs.invokta.dev/) Action Engine with one
deterministic capability shared by direct, CLI, and MCP stdio entry points.

## Validate

\`\`\`sh
${commands.check}
\`\`\`

## Invoke directly

\`\`\`sh
${commands.direct}
\`\`\`

## Use the CLI

\`\`\`sh
${commands.list}
${commands.run}
\`\`\`

## Start MCP stdio

\`\`\`sh
${commands.stdio}
\`\`\`

MCP stdio reserves standard output for protocol messages. Install this engine in
all detected MCP clients with:

\`\`\`sh
${runScript("mcp:install")}
\`\`\`

Remove this engine from every client where Invokta still owns its definition
without rebuilding it:

\`\`\`sh
${runScript("mcp:uninstall")}
\`\`\`

Add stateless HTTP only when needed. Install \`@invokta/deploy\`, run
\`invokta-deploy init\`, and implement its fail-closed authentication hook before
exposing the endpoint.
`;
}

function renderAgentInstructions(packageManager: PackageManager): string {
  const commands = packageManagerCommands[packageManager];
  return `# Project Instructions

## Language

Write all project content in English, including documentation, source comments,
public errors, examples, tests, commits, and release notes.

## Architecture

- Define domain actions as capabilities with explicit input, output, access, and execution contracts.
- Keep direct, CLI, and MCP entry points on the single \`engine.invoke\` path.
- Keep models, prompts, providers, data stores, and tools behind replaceable engine-owned dependencies.
- Do not add framework-wide registries, service locators, or adapter-specific business logic.

## Delivery

- Follow RED, GREEN, REFACTOR for executable behavior.
- Run \`${commands.check}\` before completing a change.
- Keep \`CLAUDE.md\` as a symbolic link to this file so agent instructions have one source of truth.
`;
}

function renderDevelopmentSkill(packageManager: PackageManager): string {
  const commands = packageManagerCommands[packageManager];
  return `---
name: develop-invokta-project
description: Develop this generated Invokta Action Engine when adding or changing capabilities, dependencies, tests, direct calls, CLI behavior, or MCP behavior. Use for implementation, refactoring, debugging, and contract review in this project.
---

# Develop This Action Engine

## Establish the contract

1. Read \`AGENTS.md\`, \`README.md\`, and the existing capability and engine tests.
2. Identify the domain action, public capability ID, input, output, access rule, annotations, timeout, and observable errors affected by the change.
3. Treat capability IDs, schemas, access behavior, and adapter-visible results as compatibility surfaces. Request an explicit decision before breaking one.

## Keep one architecture

- Define domain actions with \`defineCapability\` and explicit input, output, access, and execution contracts.
- Inject models, providers, repositories, tools, and policy checks through engine-owned factories or closures.
- Register capabilities under literal domain-oriented IDs in \`src/engine.ts\`.
- Keep every execution channel on \`engine.invoke\`; never call a capability's \`run\` directly.
- Keep business logic out of \`src/direct.ts\`, \`src/cli.ts\`, and \`src/mcp-stdio.ts\`.
- Do not add a service locator, runtime registry, plugin discovery, workflow engine, or adapter-specific capability implementation.

## Deliver the change

1. Add or update an engine-level test that invokes the capability and fails for the missing behavior.
2. Implement the smallest capability, dependency, composition-root, or adapter wiring change that makes the test pass.
3. Cover invalid input, denied access, output validation, cancellation, or dependency failure when relevant to the contract.
4. Keep direct, CLI, and MCP behavior consistent by testing the shared engine boundary rather than duplicating handlers.
5. Update project documentation when commands, configuration, capability IDs, or public behavior change.
6. Run \`${commands.check}\` and resolve every type, test, formatting, and build failure before completion.
`;
}

const developmentSkillMetadata = `interface:
  display_name: "Develop Invokta Action Engine"
  short_description: "Develop this Invokta Action Engine safely"
  default_prompt: "Use $develop-invokta-project to implement this Action Engine change through the single engine.invoke path."
`;

function renderPackageManifest(
  projectName: string,
  invoktaVersion: string,
): string {
  const manifest = {
    name: projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: ">=22.20.0" },
    scripts: {
      build: "tsc -p tsconfig.json --pretty false",
      typecheck:
        "tsc -p tsconfig.json --pretty false --noEmit && tsc -p tsconfig.test.json --pretty false --noEmit",
      test: "vitest run",
      check:
        "tsc -p tsconfig.json --pretty false --noEmit && tsc -p tsconfig.test.json --pretty false --noEmit && vitest run && tsc -p tsconfig.json --pretty false",
      direct: "node dist/direct.js",
      cli: "node dist/cli.js",
      "mcp:stdio": "node dist/mcp-stdio.js",
      "mcp:install":
        "tsc -p tsconfig.json --pretty false && invokta-installer install --engine .",
      "mcp:uninstall": "invokta-installer remove --engine .",
    },
    dependencies: {
      "@invokta/cli": invoktaVersion,
      "@invokta/core": invoktaVersion,
      "@invokta/mcp": invoktaVersion,
      zod: "4.4.3",
    },
    devDependencies: {
      "@invokta/installer": invoktaVersion,
      "@types/node": "26.1.2",
      typescript: "7.0.2",
      vitest: "4.1.10",
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function renderMcpInstallManifest(projectName: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id: projectName,
      version: "0.1.0",
      title: projectName,
      description: `MCP access to the ${projectName} Action Engine.`,
      capabilityIds: ["onboarding.create-welcome-message"],
      server: {
        name: projectName,
        entrypoint: "dist/mcp-stdio.js",
        forwardEnv: [],
      },
    },
    null,
    2,
  )}\n`;
}

const capabilityModule = `import { defineCapability } from "@invokta/core";
import { z } from "zod";

export const createWelcomeMessage = defineCapability({
  title: "Create a welcome message",
  description: "Creates a short welcome message for a new team member.",
  input: z.object({ name: z.string().trim().min(1) }),
  output: z.object({ message: z.string().min(1) }),
  access: "public",
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  async run({ input }) {
    return { message: \`Welcome, \${input.name}!\` };
  },
});
`;

function renderEngineModule(projectName: string): string {
  return `import { createEngine } from "@invokta/core";

import { createWelcomeMessage } from "./capabilities/create-welcome-message.js";

export const engine = createEngine({
  name: ${JSON.stringify(projectName)},
  version: "0.1.0",
  capabilities: {
    "onboarding.create-welcome-message": createWelcomeMessage,
  },
});
`;
}

const cliModule = `import { runCli } from "@invokta/cli";

import { engine } from "./engine.js";

process.exitCode = await runCli(engine, { principal: null });
`;

const directModule = `import { engine } from "./engine.js";

const name = process.argv.slice(2).join(" ").trim() || "Developer";
const result = await engine.invoke(
  "onboarding.create-welcome-message",
  { name },
  { source: "direct", principal: null },
);

process.stdout.write(\`\${JSON.stringify(result)}\\n\`);
`;

const mcpStdioModule = `import { serveMcpStdio } from "@invokta/mcp";

import { engine } from "./engine.js";

await serveMcpStdio(engine, { principal: null });
`;

const engineTestModule = `import { describe, expect, it } from "vitest";

import { engine } from "../src/engine.js";

describe("welcome engine", () => {
  it("creates a validated welcome message", async () => {
    await expect(
      engine.invoke(
        "onboarding.create-welcome-message",
        { name: "  Ada  " },
        { principal: null },
      ),
    ).resolves.toEqual({ message: "Welcome, Ada!" });
  });

  it("rejects an empty name", async () => {
    await expect(
      engine.invoke(
        "onboarding.create-welcome-message",
        { name: "   " },
        { principal: null },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});
`;

const tsconfig = `{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "moduleDetection": "force",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
`;

const tsconfigTest = `{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
`;

/** Returns the complete starter as deterministic project-relative entries. */
export function createStarterFiles(
  options: CreateStarterFilesOptions,
): readonly StarterEntry[] {
  return Object.freeze([
    {
      kind: "file",
      path: ".agents/skills/develop-invokta-project/SKILL.md",
      contents: renderDevelopmentSkill(options.packageManager),
    },
    {
      kind: "file",
      path: ".agents/skills/develop-invokta-project/agents/openai.yaml",
      contents: developmentSkillMetadata,
    },
    {
      kind: "file",
      path: ".gitignore",
      contents: "node_modules/\ndist/\n*.tsbuildinfo\n",
    },
    {
      kind: "file",
      path: "AGENTS.md",
      contents: renderAgentInstructions(options.packageManager),
    },
    { kind: "symlink", path: "CLAUDE.md", target: "AGENTS.md" },
    {
      kind: "file",
      path: "README.md",
      contents: renderReadme(options.projectName, options.packageManager),
    },
    {
      kind: "file",
      path: "invokta.mcp.json",
      contents: renderMcpInstallManifest(options.projectName),
    },
    {
      kind: "file",
      path: "package.json",
      contents: renderPackageManifest(
        options.projectName,
        options.invoktaVersion,
      ),
    },
    {
      kind: "file",
      path: "src/capabilities/create-welcome-message.ts",
      contents: capabilityModule,
    },
    { kind: "file", path: "src/cli.ts", contents: cliModule },
    { kind: "file", path: "src/direct.ts", contents: directModule },
    {
      kind: "file",
      path: "src/engine.ts",
      contents: renderEngineModule(options.projectName),
    },
    { kind: "file", path: "src/mcp-stdio.ts", contents: mcpStdioModule },
    {
      kind: "file",
      path: "test/engine.test.ts",
      contents: engineTestModule,
    },
    { kind: "file", path: "tsconfig.json", contents: tsconfig },
    {
      kind: "file",
      path: "tsconfig.test.json",
      contents: tsconfigTest,
    },
  ]);
}
