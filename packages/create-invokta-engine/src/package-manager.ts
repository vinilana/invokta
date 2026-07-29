export type PackageManager = "npm" | "pnpm" | "yarn";

export interface PackageManagerCommands {
  readonly installExecutable: PackageManager;
  readonly installArguments: readonly string[];
  readonly installDisplay: string;
  readonly check: string;
  readonly direct: string;
  readonly list: string;
  readonly run: string;
  readonly stdio: string;
}

export const packageManagerCommands = Object.freeze({
  npm: Object.freeze({
    installExecutable: "npm",
    installArguments: Object.freeze(["install", "--no-audit", "--no-fund"]),
    installDisplay: "npm install --no-audit --no-fund",
    check: "npm run check",
    direct: "npm run direct -- Ada",
    list: "npm run cli -- list",
    run: 'npm run cli -- run onboarding.create-welcome-message --input \'{"name":"Ada"}\'',
    stdio: "npm run mcp:stdio",
  }),
  pnpm: Object.freeze({
    installExecutable: "pnpm",
    installArguments: Object.freeze(["install"]),
    installDisplay: "pnpm install",
    check: "pnpm run check",
    direct: "pnpm run direct Ada",
    list: "pnpm run cli list",
    run: 'pnpm run cli run onboarding.create-welcome-message --input \'{"name":"Ada"}\'',
    stdio: "pnpm run mcp:stdio",
  }),
  yarn: Object.freeze({
    installExecutable: "yarn",
    installArguments: Object.freeze(["install"]),
    installDisplay: "yarn install",
    check: "yarn check",
    direct: "yarn direct Ada",
    list: "yarn cli list",
    run: 'yarn cli run onboarding.create-welcome-message --input \'{"name":"Ada"}\'',
    stdio: "yarn mcp:stdio",
  }),
} as const) satisfies Readonly<Record<PackageManager, PackageManagerCommands>>;

export const packageManagers = Object.freeze([
  "npm",
  "pnpm",
  "yarn",
] as const satisfies readonly PackageManager[]);

export function isPackageManager(value: string): value is PackageManager {
  return packageManagers.some((manager) => manager === value);
}
