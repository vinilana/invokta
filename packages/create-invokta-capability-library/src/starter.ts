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
  return `# ${projectName}

A standalone Invokta capability-library package. It exports one explicit
\`defineCapabilityLibrary\` value containing two related example capabilities
that an Action Engine can select and remap at its composition root.

## Validate

\`\`\`sh
${commands.check}
\`\`\`

## Publish deliberately

The starter is private. Before publishing, choose the final package and library
names, version, default capability IDs, and compatibility policy, then remove
\`"private": true\` from \`package.json\`.
`;
}

function renderAgentInstructions(packageManager: PackageManager): string {
  const commands = packageManagerCommands[packageManager];
  return `# Project Instructions

## Language

Write all project content in English, including documentation, source comments,
public errors, examples, tests, commits, and release notes.

## Capability contracts

- Treat default capability IDs as stable public API.
- Keep IDs literal and compose explicitly through \`@invokta/core\`.
- Inject repositories, providers, models, and policy checks through factories or closures.
- Do not add runtime discovery, registries, adapters, or execution entry points.

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
description: Develop this generated Invokta capability-library package when changing capability contracts, dependencies, default IDs, library metadata, tests, or the package export. Use for implementation, refactoring, debugging, and compatibility review in this project.
---

# Develop This Capability Library

## Establish the publication contract

1. Read \`AGENTS.md\`, \`README.md\`, \`package.json\`, \`src/index.ts\`, the capability modules, and \`test/library.test.ts\`.
2. Identify the input, output, access rule, annotations, timeout, default IDs, library name and version, ordering, and root export affected by the change.
3. Treat schemas, access behavior, literal default IDs, capability order, library identity, and package exports as compatibility surfaces. Request an explicit decision before breaking one.

## Preserve the library boundary

- Keep each domain action as an independent \`defineCapability\` value in \`src/capabilities/\`.
- Publish through \`defineCapabilityLibrary\` in \`src/index.ts\` with literal, domain-oriented default IDs.
- Inject repositories, providers, models, tools, and policy checks through a library factory or closure when dependencies are needed.
- Keep the library independent from CLI, MCP, HTTP, and any consuming engine.
- Do not add runtime discovery, a registry, a service locator, an adapter, or an engine entry point.

## Deliver the change

1. Add or update a test that imports the public library, selects or remaps with \`importCapabilities\`, composes an engine, invokes through \`engine.invoke\`, and fails for the missing behavior.
2. Implement the smallest capability or library-publication change that makes the test pass.
3. Cover invalid input, denied access, output validation, cancellation, dependency failure, selection, and remapping when relevant to the contract.
4. Keep \`private: true\` until library identity, versioning, default-ID compatibility, and publication are deliberate decisions.
5. Update project documentation when the public contract or package usage changes.
6. Run \`${commands.check}\` and resolve every type, test, formatting, and build failure before completion.
`;
}

const developmentSkillMetadata = `interface:
  display_name: "Develop Invokta Capability Library"
  short_description: "Develop this Invokta capability library"
  default_prompt: "Use $develop-invokta-project to implement this capability-library change and validate its default IDs and composition contract."
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
    sideEffects: false,
    engines: { node: ">=22.20.0" },
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    scripts: {
      build: "tsc -p tsconfig.json --pretty false",
      typecheck:
        "tsc -p tsconfig.json --pretty false --noEmit && tsc -p tsconfig.test.json --pretty false --noEmit",
      test: "vitest run",
      check:
        "tsc -p tsconfig.json --pretty false --noEmit && tsc -p tsconfig.test.json --pretty false --noEmit && vitest run && tsc -p tsconfig.json --pretty false",
    },
    dependencies: {
      "@invokta/core": invoktaVersion,
      zod: "4.4.3",
    },
    devDependencies: {
      "@types/node": "26.1.2",
      typescript: "7.0.2",
      vitest: "^4.1.10",
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const welcomeCapabilityModule = `import { defineCapability } from "@invokta/core";
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

const farewellCapabilityModule = `import { defineCapability } from "@invokta/core";
import { z } from "zod";

export const createFarewellMessage = defineCapability({
  title: "Create a farewell message",
  description: "Creates a short farewell message for a team member.",
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
    return { message: \`Farewell, \${input.name}!\` };
  },
});
`;

function renderIndexModule(projectName: string): string {
  return `import { defineCapabilityLibrary } from "@invokta/core";

import { createFarewellMessage } from "./capabilities/create-farewell-message.js";
import { createWelcomeMessage } from "./capabilities/create-welcome-message.js";

export const onboardingCapabilityLibrary = defineCapabilityLibrary({
  name: ${JSON.stringify(projectName)},
  version: "0.1.0",
  capabilities: {
    "onboarding.create-welcome-message": createWelcomeMessage,
    "onboarding.create-farewell-message": createFarewellMessage,
  },
});
`;
}

const libraryTestModule = `import {
  composeCapabilities,
  createEngine,
  importCapabilities,
} from "@invokta/core";
import { describe, expect, it } from "vitest";

import { onboardingCapabilityLibrary } from "../src/index.js";

const engine = createEngine({
  name: "capability-library-test-engine",
  version: "0.0.0-test",
  capabilities: composeCapabilities({
    imports: [
      importCapabilities(onboardingCapabilityLibrary, {
        include: ["onboarding.create-welcome-message"],
        remap: {
          "onboarding.create-welcome-message": "team.welcome-member",
        },
      }),
    ],
  }),
});

describe("the onboarding capability library", () => {
  it("selects, remaps, and invokes through the engine boundary", async () => {
    expect(engine.list().map((capability) => capability.id)).toEqual([
      "team.welcome-member",
    ]);
    await expect(
      engine.invoke(
        "team.welcome-member",
        { name: "  Ada  " },
        { principal: null },
      ),
    ).resolves.toEqual({ message: "Welcome, Ada!" });
  });

  it("keeps validation at the engine boundary", async () => {
    await expect(
      engine.invoke(
        "team.welcome-member",
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
    "declaration": true,
    "declarationMap": true,
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
      path: "package.json",
      contents: renderPackageManifest(
        options.projectName,
        options.invoktaVersion,
      ),
    },
    {
      kind: "file",
      path: "src/capabilities/create-farewell-message.ts",
      contents: farewellCapabilityModule,
    },
    {
      kind: "file",
      path: "src/capabilities/create-welcome-message.ts",
      contents: welcomeCapabilityModule,
    },
    {
      kind: "file",
      path: "src/index.ts",
      contents: renderIndexModule(options.projectName),
    },
    {
      kind: "file",
      path: "test/library.test.ts",
      contents: libraryTestModule,
    },
    { kind: "file", path: "tsconfig.json", contents: tsconfig },
    {
      kind: "file",
      path: "tsconfig.test.json",
      contents: tsconfigTest,
    },
  ]);
}
