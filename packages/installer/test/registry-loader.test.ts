import { describe, expect, it, vi } from "vitest";

import type { InstallerFileSystem } from "../src/file-system.js";
import { InstallerError } from "../src/installer-error.js";
import type { RegistryCompatibilityAdapters } from "../src/registry.js";
import {
  bundledRegistryUrl,
  configurationTargetIds,
  loadBundledRegistry,
} from "../src/registry.js";

const emptyRegistryBytes = new TextEncoder().encode(
  `${JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2)}\n`,
);

const inspectMissing: InstallerFileSystem["inspectPath"] = async () =>
  ({ kind: "missing" }) as const;

function adapters(): RegistryCompatibilityAdapters {
  return Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      () => ({ supported: true }) as const,
    ]),
  ) as unknown as RegistryCompatibilityAdapters;
}

describe("bundled registry loader", () => {
  it("loads the immutable source package-relative through the injected filesystem", async () => {
    const readFile = vi.fn(async () => emptyRegistryBytes);
    const fileSystem: InstallerFileSystem = {
      readFile,
      inspectPath: inspectMissing,
    };

    const registry = await loadBundledRegistry(fileSystem, adapters());

    expect(registry).toEqual({ schemaVersion: 1, entries: [] });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(bundledRegistryUrl);
    expect(bundledRegistryUrl).toEqual(
      new URL("../registry/capabilities.json", import.meta.url),
    );
  });

  it("maps read, decoding, parsing, and validation failures to REGISTRY_INVALID", async () => {
    const privateCause = new Error("private registry path");
    const failures: readonly InstallerFileSystem[] = [
      {
        readFile: async () => Promise.reject(privateCause),
        inspectPath: inspectMissing,
      },
      {
        readFile: async () => Uint8Array.from([0x80]),
        inspectPath: inspectMissing,
      },
      {
        readFile: async () => new TextEncoder().encode("not-json"),
        inspectPath: inspectMissing,
      },
      {
        readFile: async () =>
          new TextEncoder().encode(
            JSON.stringify({ schemaVersion: 2, entries: [] }),
          ),
        inspectPath: inspectMissing,
      },
    ];

    for (const fileSystem of failures) {
      let error: unknown;
      try {
        await loadBundledRegistry(fileSystem, adapters());
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(InstallerError);
      expect(error).toMatchObject({
        code: "REGISTRY_INVALID",
        message: "The local capability registry is invalid.",
      });
      expect(String(error)).not.toContain("private registry path");
    }
  });
});
