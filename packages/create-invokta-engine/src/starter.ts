export type PackageManager = "npm" | "pnpm" | "yarn";

export interface StarterFile {
  /** Project-relative POSIX path. */
  readonly path: string;
  readonly contents: string;
}

export interface CreateStarterFilesOptions {
  readonly projectName: string;
  readonly invoktaVersion: string;
  readonly packageManager: PackageManager;
}

const packageManagerCommands = Object.freeze({
  npm: Object.freeze({
    check: "npm run check",
    direct: "npm run direct -- Ada",
    list: "npm run cli -- list",
    run: 'npm run cli -- run onboarding.create-welcome-message --input \'{"name":"Ada"}\'',
    stdio: "npm run mcp:stdio",
  }),
  pnpm: Object.freeze({
    check: "pnpm run check",
    direct: "pnpm run direct Ada",
    list: "pnpm run cli list",
    run: 'pnpm run cli run onboarding.create-welcome-message --input \'{"name":"Ada"}\'',
    stdio: "pnpm run mcp:stdio",
  }),
  yarn: Object.freeze({
    check: "yarn check",
    direct: "yarn direct Ada",
    list: "yarn cli list",
    run: 'yarn cli run onboarding.create-welcome-message --input \'{"name":"Ada"}\'',
    stdio: "yarn mcp:stdio",
  }),
} as const satisfies Readonly<
  Record<
    PackageManager,
    Readonly<{
      check: string;
      direct: string;
      list: string;
      run: string;
      stdio: string;
    }>
  >
>);

function renderReadme(
  projectName: string,
  packageManager: PackageManager,
): string {
  const commands = packageManagerCommands[packageManager];
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

MCP stdio reserves standard output for protocol messages. Configure a client to
start the compiled \`dist/mcp-stdio.js\` file directly with Node.

Add stateless HTTP only when needed. Install \`@invokta/deploy\`, run
\`invokta-deploy init\`, and implement its fail-closed authentication hook before
exposing the endpoint.
`;
}

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
    },
    dependencies: {
      "@invokta/cli": invoktaVersion,
      "@invokta/core": invoktaVersion,
      "@invokta/mcp": invoktaVersion,
      zod: "4.4.3",
    },
    devDependencies: {
      "@types/node": "26.1.2",
      typescript: "7.0.2",
      vitest: "4.1.10",
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
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

/** Returns the complete starter as deterministic, project-relative text files. */
export function createStarterFiles(
  options: CreateStarterFilesOptions,
): readonly StarterFile[] {
  return Object.freeze([
    { path: ".gitignore", contents: "node_modules/\ndist/\n*.tsbuildinfo\n" },
    {
      path: "README.md",
      contents: renderReadme(options.projectName, options.packageManager),
    },
    {
      path: "package.json",
      contents: renderPackageManifest(
        options.projectName,
        options.invoktaVersion,
      ),
    },
    {
      path: "src/capabilities/create-welcome-message.ts",
      contents: capabilityModule,
    },
    { path: "src/cli.ts", contents: cliModule },
    { path: "src/direct.ts", contents: directModule },
    {
      path: "src/engine.ts",
      contents: renderEngineModule(options.projectName),
    },
    { path: "src/mcp-stdio.ts", contents: mcpStdioModule },
    { path: "test/engine.test.ts", contents: engineTestModule },
    { path: "tsconfig.json", contents: tsconfig },
    { path: "tsconfig.test.json", contents: tsconfigTest },
  ]);
}
