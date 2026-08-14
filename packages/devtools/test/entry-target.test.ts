import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseEntryPoint } from "../src/entry-target.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "invokta-entry-target-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("parseEntryPoint", () => {
  it("resolves a project entry point to its canonical path", () => {
    const project = makeRoot();
    writeFileSync(join(project, "cli.js"), "export {};\n");

    const entry = parseEntryPoint({ kind: "project", path: "cli.js" }, project);

    expect(entry.kind).toBe("project");
    if (entry.kind !== "project") return;
    expect(entry.path).toBe("cli.js");
  });

  it("rejects a lexical escape from the project directory", () => {
    const project = makeRoot();

    expect(() =>
      parseEntryPoint({ kind: "project", path: "../outside.js" }, project),
    ).toThrow(/inside the directory/);
  });

  it("rejects a symlink that names a file outside the project", () => {
    // The lexical path sits inside the project, but the file it actually
    // names does not — canonical identity is what the containment rule
    // guards, since the canonical path is what the child process runs.
    const outside = makeRoot();
    const project = makeRoot();
    const target = join(outside, "entry.js");
    writeFileSync(target, "export {};\n");
    symlinkSync(target, join(project, "link.js"));

    expect(() =>
      parseEntryPoint({ kind: "project", path: "link.js" }, project),
    ).toThrow(/inside the directory/);
  });

  it("rejects an entry point that does not exist", () => {
    const project = makeRoot();

    expect(() =>
      parseEntryPoint({ kind: "project", path: "missing.js" }, project),
    ).toThrow(/does not exist/);
  });
});
