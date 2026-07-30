export type PackageManager = "npm" | "pnpm" | "yarn";

export interface PackageManagerCommands {
  readonly installExecutable: PackageManager;
  readonly installArguments: readonly string[];
  readonly installDisplay: string;
  readonly check: string;
}

export const packageManagerCommands = Object.freeze({
  npm: Object.freeze({
    installExecutable: "npm",
    installArguments: Object.freeze(["install", "--no-audit", "--no-fund"]),
    installDisplay: "npm install --no-audit --no-fund",
    check: "npm run check",
  }),
  pnpm: Object.freeze({
    installExecutable: "pnpm",
    installArguments: Object.freeze(["install"]),
    installDisplay: "pnpm install",
    check: "pnpm run check",
  }),
  yarn: Object.freeze({
    installExecutable: "yarn",
    installArguments: Object.freeze(["install"]),
    installDisplay: "yarn install",
    check: "yarn run check",
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
