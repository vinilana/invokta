import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeFileSystem } from "../src/node-file-system.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Node installer filesystem adapter", () => {
  it("reads bytes through the internal injectable boundary", async () => {
    const fileSystem = createNodeFileSystem();

    const bytes = await fileSystem.readFile(
      new URL("../package.json", import.meta.url),
    );
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly name: string;
    };

    expect(manifest.name).toBe("@invokta/installer-core");
  });

  it("classifies paths without following symbolic links", async () => {
    const directory = mkdtempSync(join(tmpdir(), "invokta-file-system-"));
    temporaryDirectories.push(directory);
    const regularFile = join(directory, "config.json");
    const childDirectory = join(directory, "configs");
    const symbolicLink = join(directory, "config-link.json");
    writeFileSync(regularFile, "{}\n");
    mkdirSync(childDirectory);
    symlinkSync(regularFile, symbolicLink);
    const fileSystem = createNodeFileSystem();
    if (process.getuid === undefined) {
      throw new Error("POSIX user identity is required by this fixture.");
    }
    const ownerId = process.getuid();

    await expect(fileSystem.inspectPath(regularFile)).resolves.toEqual({
      kind: "regular-file",
      ownerId,
      realPath: realpathSync(regularFile),
    });
    await expect(fileSystem.inspectPath(childDirectory)).resolves.toEqual({
      kind: "directory",
      ownerId,
      realPath: realpathSync(childDirectory),
    });
    await expect(fileSystem.inspectPath(symbolicLink)).resolves.toEqual({
      kind: "symbolic-link",
      ownerId,
    });
    await expect(
      fileSystem.inspectPath(join(directory, "missing.json")),
    ).resolves.toEqual({ kind: "missing" });
  });
});
