import {
  createMcpHttpScaffoldFiles,
  starterDeployManifest,
} from "@invokta/deploy/scaffold";

import {
  type PackageManager,
  packageManagerCommands,
} from "./package-manager.js";

export const engineStarterProfiles = Object.freeze([
  "complete",
  "mcp-stdio",
  "mcp-http",
  "cli",
] as const);

export type EngineStarterProfile = (typeof engineStarterProfiles)[number];

export function isEngineStarterProfile(
  value: string,
): value is EngineStarterProfile {
  return engineStarterProfiles.some((profile) => profile === value);
}

interface ProfileFeatures {
  readonly cli: boolean;
  readonly mcpStdio: boolean;
  readonly mcpHttp: boolean;
}

function profileFeatures(profile: EngineStarterProfile): ProfileFeatures {
  return Object.freeze({
    cli: profile === "complete" || profile === "cli",
    mcpStdio: profile === "complete" || profile === "mcp-stdio",
    mcpHttp: profile === "complete" || profile === "mcp-http",
  });
}

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
  readonly profile: EngineStarterProfile;
}

function renderReadme(
  projectName: string,
  packageManager: PackageManager,
  profile: EngineStarterProfile,
): string {
  const commands = packageManagerCommands[packageManager];
  const runScript = (name: string) =>
    packageManager === "yarn"
      ? `yarn ${name}`
      : `${packageManager} run ${name}`;
  const features = profileFeatures(profile);
  const generatedChannels = [
    "direct invocation",
    ...(features.cli ? ["CLI"] : []),
    ...(features.mcpStdio ? ["MCP stdio"] : []),
    ...(features.mcpHttp ? ["MCP HTTP"] : []),
  ];
  const channelSummary =
    generatedChannels.length === 2
      ? generatedChannels.join(" and ")
      : `${generatedChannels.slice(0, -1).join(", ")}, and ${generatedChannels.at(-1)}`;
  const cliSection = features.cli
    ? `
## Use the CLI

\`\`\`sh
${commands.list}
${commands.run}
\`\`\`
`
    : "";
  const stdioSection = features.mcpStdio
    ? `
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

The package also defines the \`${projectName}\` executable for a durable
packaged distribution. This starter remains private by default; before registry
publication, choose the package's license and access metadata deliberately and
remove \`"private": true\`.

After distribution, a consumer can install or remove the engine without this
checkout:

\`\`\`sh
${projectName} install
${projectName} uninstall
\`\`\`

Run \`install\` from a durable location, such as a global package
installation; the recorded launch descriptor points at this package's absolute
entry-point path, so an ephemeral package-runner cache invalidates it.
`
    : "";
  const httpSection = features.mcpHttp
    ? `
## Start MCP HTTP

Implement the fail-closed authentication hook in \`src/http-auth.ts\` before the
server can start. Then run:

\`\`\`sh
${runScript("mcp:http")}
\`\`\`

Package the server and probe an existing endpoint with:

\`\`\`sh
${runScript("deploy:package")}
${runScript("deploy:probe")}
\`\`\`
`
    : "";
  return `# ${projectName}

A standalone [Invokta](https://docs.invokta.dev/) Action Engine with one
deterministic capability shared by ${channelSummary} entry points.

## Validate

\`\`\`sh
${commands.check}
\`\`\`

## Invoke directly

\`\`\`sh
${commands.direct}
\`\`\`

## Develop interactively

\`\`\`sh
${runScript("devtools")}
\`\`\`

Builds the engine and starts the Invokta devtools on http://127.0.0.1:4100/:
browse capabilities, invoke them from schema-seeded JSON, follow the live
invocation trace, switch development principals, and read the doctor report.
Source changes rebuild and restart the hosted engine automatically.

The existing \`${runScript("dev")}\` command remains a short compatible alias.
Run the read-only project checks with:

\`\`\`sh
${runScript("devtools:doctor")}
\`\`\`
${cliSection}${stdioSection}${httpSection}`;
}

function renderAgentInstructions(
  packageManager: PackageManager,
  profile: EngineStarterProfile,
): string {
  const commands = packageManagerCommands[packageManager];
  const features = profileFeatures(profile);
  const entryPoints = [
    "direct",
    ...(features.cli ? ["CLI"] : []),
    ...(features.mcpStdio ? ["MCP stdio"] : []),
    ...(features.mcpHttp ? ["MCP HTTP"] : []),
  ].join(", ");
  const adapterPaths = [
    "`src/direct.ts`",
    ...(features.cli ? ["`src/cli.ts`"] : []),
    ...(features.mcpStdio ? ["`src/mcp-stdio.ts`"] : []),
    ...(features.mcpHttp ? ["`src/mcp-http.ts`"] : []),
  ].join(", ");
  const httpInstruction = features.mcpHttp
    ? "\n- Keep HTTP authentication fail-closed until `src/http-auth.ts` verifies a real credential."
    : "";
  return `# Project Instructions

## Language

Write all project content in English, including documentation, source comments,
public errors, examples, tests, commits, and release notes.

## Architecture

- Define domain actions as capabilities with explicit input, output, access, and execution contracts.
- Keep the generated ${entryPoints} entry points on the single \`engine.invoke\` path.
- Keep models, prompts, providers, data stores, and tools behind replaceable engine-owned dependencies.
- Keep business logic out of ${adapterPaths}.
- Do not add framework-wide registries, service locators, or adapter-specific business logic.${httpInstruction}

## Delivery

- Follow RED, GREEN, REFACTOR for executable behavior.
- Run \`${commands.check}\` before completing a change.
- Keep \`CLAUDE.md\` as a symbolic link to this file so agent instructions have one source of truth.
`;
}

function renderDevelopmentSkill(
  packageManager: PackageManager,
  profile: EngineStarterProfile,
): string {
  const commands = packageManagerCommands[packageManager];
  const features = profileFeatures(profile);
  const channelNames = [
    "direct invocation",
    ...(features.cli ? ["CLI"] : []),
    ...(features.mcpStdio ? ["MCP stdio"] : []),
    ...(features.mcpHttp ? ["MCP HTTP"] : []),
  ];
  const channels =
    channelNames.length === 2
      ? channelNames.join(" and ")
      : `${channelNames.slice(0, -1).join(", ")}, and ${channelNames.at(-1)}`;
  const adapterPaths = [
    "`src/direct.ts`",
    ...(features.cli ? ["`src/cli.ts`"] : []),
    ...(features.mcpStdio ? ["`src/mcp-stdio.ts`"] : []),
    ...(features.mcpHttp ? ["`src/mcp-http.ts`"] : []),
  ].join(", ");
  const httpInstruction = features.mcpHttp
    ? "\n- Preserve fail-closed authentication in `src/http-auth.ts`; never add a development bypass."
    : "";
  return `---
name: develop-invokta-project
description: Develop this generated Invokta Action Engine when changing capabilities, dependencies, tests, or its ${channels} channels. Use for implementation, refactoring, debugging, and contract review in this project.
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
- Keep business logic out of ${adapterPaths}.
- Do not add a service locator, runtime registry, plugin discovery, workflow engine, or adapter-specific capability implementation.${httpInstruction}

## Deliver the change

1. Add or update an engine-level test that invokes the capability and fails for the missing behavior.
2. Implement the smallest capability, dependency, composition-root, or adapter wiring change that makes the test pass.
3. Cover invalid input, denied access, output validation, cancellation, or dependency failure when relevant to the contract.
4. Keep ${channels} behavior consistent by testing the shared engine boundary rather than duplicating handlers.
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
  profile: EngineStarterProfile,
): string {
  const features = profileFeatures(profile);
  const devtoolsServe =
    'tsc -p tsconfig.json --pretty false && invokta-devtools serve dist/engine.js --watch --build "tsc -p tsconfig.json --pretty false"';
  const devtoolsDoctor =
    "tsc -p tsconfig.json --pretty false && invokta-devtools doctor dist/engine.js";
  const scripts = {
    build: "tsc -p tsconfig.json --pretty false",
    typecheck:
      "tsc -p tsconfig.json --pretty false --noEmit && tsc -p tsconfig.test.json --pretty false --noEmit",
    test: "vitest run",
    check:
      "tsc -p tsconfig.json --pretty false --noEmit && tsc -p tsconfig.test.json --pretty false --noEmit && vitest run && tsc -p tsconfig.json --pretty false",
    direct: "node dist/direct.js",
    dev: devtoolsServe,
    devtools: devtoolsServe,
    "devtools:doctor": devtoolsDoctor,
    ...(features.cli ? { cli: "node dist/cli.js" } : {}),
    ...(features.mcpStdio
      ? {
          "mcp:stdio": "node dist/mcp-stdio.js",
          "mcp:install":
            "tsc -p tsconfig.json --pretty false && invokta-installer install --engine .",
          "mcp:uninstall": "invokta-installer remove --engine .",
        }
      : {}),
    ...(features.mcpHttp
      ? {
          "mcp:http": "node dist/mcp-http.js",
          "deploy:package": "invokta-deploy package",
          "deploy:probe": "invokta-deploy probe",
        }
      : {}),
  };
  const dependencies = {
    ...(features.cli ? { "@invokta/cli": invoktaVersion } : {}),
    "@invokta/core": invoktaVersion,
    ...(features.mcpStdio ? { "@invokta/installer": invoktaVersion } : {}),
    ...(features.mcpStdio || features.mcpHttp
      ? { "@invokta/mcp": invoktaVersion }
      : {}),
    zod: "4.4.3",
  };
  const devDependencies = {
    ...(features.mcpHttp ? { "@invokta/deploy": invoktaVersion } : {}),
    "@invokta/devtools": invoktaVersion,
    "@types/node": "26.1.2",
    typescript: "7.0.2",
    vitest: "4.1.10",
  };
  const manifest = {
    name: projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: ">=22.20.0" },
    ...(features.mcpStdio
      ? {
          bin: { [projectName]: "./dist/bin.js" },
          files: ["dist", "invokta.mcp.json"],
        }
      : {}),
    scripts,
    dependencies,
    devDependencies,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function renderBinModule(projectName: string): string {
  return `#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { runEngineInstallerCli } from "@invokta/installer/engine";

process.exitCode = await runEngineInstallerCli({
  argv: process.argv.slice(2),
  binaryName: ${JSON.stringify(projectName)},
  packageRoot: fileURLToPath(new URL("..", import.meta.url)),
});
`;
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

function starterFile(path: string, contents: string): StarterEntry {
  return Object.freeze({ kind: "file", path, contents });
}

function starterSymlink(path: string, target: string): StarterEntry {
  return Object.freeze({ kind: "symlink", path, target });
}

function compareStarterEntries(
  left: StarterEntry,
  right: StarterEntry,
): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/** Returns one deterministic profile as immutable project-relative entries. */
export function createStarterFiles(
  options: CreateStarterFilesOptions,
): readonly StarterEntry[] {
  const features = profileFeatures(options.profile);
  const entries: StarterEntry[] = [
    starterFile(
      ".agents/skills/develop-invokta-project/SKILL.md",
      renderDevelopmentSkill(options.packageManager, options.profile),
    ),
    starterFile(
      ".agents/skills/develop-invokta-project/agents/openai.yaml",
      developmentSkillMetadata,
    ),
    starterFile(
      ".gitignore",
      features.mcpHttp
        ? "node_modules/\ndist/\n*.tsbuildinfo\n.env\n.env.*\n!.env.example\n"
        : "node_modules/\ndist/\n*.tsbuildinfo\n",
    ),
    starterFile(
      "AGENTS.md",
      renderAgentInstructions(options.packageManager, options.profile),
    ),
    starterSymlink("CLAUDE.md", "AGENTS.md"),
    starterFile(
      "README.md",
      renderReadme(
        options.projectName,
        options.packageManager,
        options.profile,
      ),
    ),
    starterFile(
      "package.json",
      renderPackageManifest(
        options.projectName,
        options.invoktaVersion,
        options.profile,
      ),
    ),
    starterFile("src/capabilities/create-welcome-message.ts", capabilityModule),
    starterFile("src/direct.ts", directModule),
    starterFile("src/engine.ts", renderEngineModule(options.projectName)),
    starterFile("test/engine.test.ts", engineTestModule),
    starterFile("tsconfig.json", tsconfig),
    starterFile("tsconfig.test.json", tsconfigTest),
  ];

  if (features.cli) entries.push(starterFile("src/cli.ts", cliModule));
  if (features.mcpStdio) {
    entries.push(
      starterFile(
        "invokta.mcp.json",
        renderMcpInstallManifest(options.projectName),
      ),
      starterFile("src/bin.ts", renderBinModule(options.projectName)),
      starterFile("src/mcp-stdio.ts", mcpStdioModule),
    );
  }
  if (features.mcpHttp) {
    for (const file of createMcpHttpScaffoldFiles(starterDeployManifest)) {
      entries.push(starterFile(file.path, file.contents));
    }
  }

  entries.sort(compareStarterEntries);
  return Object.freeze(entries);
}
