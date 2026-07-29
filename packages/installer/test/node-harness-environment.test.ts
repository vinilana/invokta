import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeExecutableResolver } from "../src/node-harness-environment.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "invokta-detection-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Node PATH executable resolver", () => {
  it("accepts only executable regular files, never runs them, and returns stable path identity", async () => {
    const directory = temporaryDirectory();
    const marker = join(directory, "invoked.marker");
    const executablePath = join(directory, "tool");
    writeFileSync(
      executablePath,
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 97\n`,
    );
    chmodSync(executablePath, 0o755);
    symlinkSync("tool", join(directory, "tool-alias"));
    writeFileSync(join(directory, "agy"), "#!/bin/sh\nexit 97\n");
    chmodSync(join(directory, "agy"), 0o755);
    symlinkSync("agy", join(directory, "antigravity"));
    writeFileSync(join(directory, "not-executable"), "fixture\n");
    chmodSync(join(directory, "not-executable"), 0o644);
    mkdirSync(join(directory, "directory-tool"), { mode: 0o755 });
    const resolveExecutable = createNodeExecutableResolver({
      pathValue: directory,
    });

    const executable = await resolveExecutable("tool");
    const alias = await resolveExecutable("tool-alias");

    expect(executable).toMatchObject({ path: executablePath });
    expect(alias).toMatchObject({ path: join(directory, "tool-alias") });
    expect(alias?.identity).toEqual(executable?.identity);
    await expect(resolveExecutable("antigravity")).resolves.toMatchObject({
      legacyAliasFor: "agy",
    });
    await expect(resolveExecutable("not-executable")).resolves.toBeUndefined();
    await expect(resolveExecutable("directory-tool")).resolves.toBeUndefined();
    await expect(resolveExecutable("missing")).resolves.toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  it("resolves relative and absolute path commands to executable regular-file evidence", async () => {
    const directory = temporaryDirectory();
    const executablePath = join(directory, "path-tool");
    const nonExecutablePath = join(directory, "path-data");
    writeFileSync(executablePath, "#!/bin/sh\nexit 97\n");
    chmodSync(executablePath, 0o755);
    writeFileSync(nonExecutablePath, "fixture\n");
    chmodSync(nonExecutablePath, 0o644);
    const resolveExecutable = createNodeExecutableResolver({ pathValue: "" });

    await expect(resolveExecutable(executablePath)).resolves.toMatchObject({
      path: executablePath,
      identity: { realPath: executablePath },
    });
    await expect(
      resolveExecutable(relative(process.cwd(), executablePath)),
    ).resolves.toMatchObject({
      path: executablePath,
      identity: { realPath: executablePath },
    });
    await expect(
      resolveExecutable(join(directory, "missing")),
    ).resolves.toBeUndefined();
    await expect(resolveExecutable(nonExecutablePath)).resolves.toBeUndefined();
    await expect(resolveExecutable(directory)).resolves.toBeUndefined();
  });
});
