import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sentinel = fileURLToPath(
  new URL("./fixtures/forbid-filesystem-writes.mjs", import.meta.url),
);

describe("filesystem-write sentinel self-probes", () => {
  it("actively proves every direct, promise, descriptor, and FileHandle guard", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        sentinel,
        "--input-type=module",
        "--eval",
        "process.stdout.write(JSON.stringify(globalThis.__INVOKTA_WRITE_SENTINEL_REPORT__))",
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      readonly direct: readonly string[];
      readonly promises: readonly string[];
      readonly fileHandle: readonly string[];
    };
    expect(report.direct).toEqual(
      expect.arrayContaining([
        "open",
        "openSync",
        "write",
        "writeSync",
        "writev",
        "writevSync",
        "mkdtemp",
        "mkdtempSync",
        "truncate",
        "truncateSync",
        "rename",
        "renameSync",
        "link",
        "linkSync",
        "symlink",
        "symlinkSync",
        "chmod",
        "chmodSync",
        "chown",
        "chownSync",
        "utimes",
        "utimesSync",
      ]),
    );
    expect(report.promises).toEqual(
      expect.arrayContaining([
        "open",
        "writeFile",
        "mkdtemp",
        "truncate",
        "rename",
        "link",
        "symlink",
        "chmod",
        "chown",
        "utimes",
      ]),
    );
    expect(report.fileHandle).toEqual(
      expect.arrayContaining([
        "appendFile",
        "chmod",
        "chown",
        "createWriteStream",
        "datasync",
        "sync",
        "truncate",
        "utimes",
        "write",
        "writeFile",
        "writev",
      ]),
    );
  });
});
