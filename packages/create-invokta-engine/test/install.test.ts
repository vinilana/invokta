import { describe, expect, it, vi } from "vitest";

import { CreatorError } from "../src/errors.js";
import {
  installProjectDependencies,
  type PackageManagerRunner,
  selectPackageManager,
} from "../src/install.js";

describe("selectPackageManager", () => {
  it.each([
    ["npm/11.0.0 node/v22.20.0", "npm"],
    ["pnpm/10.14.0 npm/? node/v22.20.0", "pnpm"],
    ["yarn/1.22.22 npm/? node/v22.20.0", "yarn"],
    [undefined, "npm"],
    ["unknown/1.0.0", "npm"],
  ] as const)("selects %s as %s", (userAgent, expected) => {
    expect(selectPackageManager(undefined, userAgent)).toBe(expected);
  });

  it("gives an explicit package manager precedence over the user agent", () => {
    expect(selectPackageManager("yarn", "pnpm/10.14.0")).toBe("yarn");
  });
});

describe("installProjectDependencies", () => {
  it.each([
    ["npm", "npm", ["install", "--no-audit", "--no-fund"]],
    ["pnpm", "pnpm", ["install"]],
    ["yarn", "yarn", ["install"]],
  ] as const)(
    "runs one shell-free %s install",
    async (manager, command, args) => {
      const runner = vi.fn<PackageManagerRunner>(async () => ({
        code: 0,
        signal: null,
      }));

      await installProjectDependencies({
        directory: "/work/my-engine",
        packageManager: manager,
        runner,
      });

      expect(runner).toHaveBeenCalledOnce();
      expect(runner).toHaveBeenCalledWith({
        command,
        args,
        cwd: "/work/my-engine",
        shell: false,
        stdio: "inherit",
      });
    },
  );

  it("normalizes a non-zero child result without exposing child output", async () => {
    const runner = vi.fn<PackageManagerRunner>(async () => ({
      code: 17,
      signal: null,
    }));

    await expect(
      installProjectDependencies({
        directory: "/work/my-engine",
        packageManager: "pnpm",
        runner,
      }),
    ).rejects.toEqual(new CreatorError("INSTALL_FAILED", ["pnpm"]));
  });

  it("normalizes an unavailable package manager", async () => {
    const runner = vi.fn<PackageManagerRunner>(async () => {
      throw new Error("fixture secret from spawn");
    });

    await expect(
      installProjectDependencies({
        directory: "/work/my-engine",
        packageManager: "yarn",
        runner,
      }),
    ).rejects.toMatchObject({
      code: "INSTALL_FAILED",
      exitCode: 1,
      details: ["yarn"],
      message: "The project dependencies could not be installed.",
    });
  });

  it("normalizes a package-manager signal as an installation failure", async () => {
    const runner = vi.fn<PackageManagerRunner>(async () => ({
      code: null,
      signal: "SIGINT",
    }));

    await expect(
      installProjectDependencies({
        directory: "/work/my-engine",
        packageManager: "npm",
        runner,
      }),
    ).rejects.toMatchObject({
      code: "INSTALL_FAILED",
      exitCode: 1,
      details: ["npm"],
    });
  });
});
