import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../..", import.meta.url);

function readRepositoryFile(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

describe("repository check", () => {
  it("keeps dependency auditing inside the canonical check", () => {
    const packageManifest = JSON.parse(readRepositoryFile("package.json")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const workflow = readRepositoryFile(
      ".github/workflows/security-and-release.yml",
    );

    expect(packageManifest.scripts["check:code"]).toBe(
      "yarn typecheck && yarn lint && yarn format:check && yarn test:coverage && yarn build",
    );
    expect(packageManifest.scripts["check:security"]).toBe(
      "yarn audit && yarn --cwd apps/docs audit",
    );
    expect(packageManifest.scripts.check).toBe(
      "yarn check:code && yarn check:security",
    );
    expect(workflow).toContain("run: yarn run check");
    expect(workflow).not.toMatch(/^\s*run: yarn audit\s*$/mu);
  });
});
