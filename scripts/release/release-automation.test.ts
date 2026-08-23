import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const expectedPackages = [
  "packages/core|@invokta/core",
  "packages/cli|@invokta/cli",
  "packages/mcp|@invokta/mcp",
  "packages/tooling|@invokta/tooling",
  "packages/installer|@invokta/installer",
  "packages/deploy|@invokta/deploy",
  "packages/devtools|@invokta/devtools",
  "packages/create-invokta-engine|create-invokta-engine",
  "packages/create-invokta-capability|create-invokta-capability",
  "packages/create-invokta-capability-library|create-invokta-capability-library",
] as const;

function read(relativePath: string): string {
  return readFileSync(`${repositoryRoot}/${relativePath}`, "utf8");
}

describe("release automation", () => {
  it("keeps publisher and verifier metadata in one machine-readable source", () => {
    const manifest = JSON.parse(
      read("scripts/release/release-packages.json"),
    ) as Array<{
      directory: string;
      name: string;
      requiredFiles: string[];
    }>;
    const output = execFileSync(
      "bash",
      [
        "-c",
        `source scripts/release/package-set.sh; printf "%s\\n" "\${release_package_entries[@]}"`,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(
      manifest.map(({ directory, name }) => `packages/${directory}|${name}`),
    ).toEqual(expectedPackages);
    expect(
      manifest.every(({ requiredFiles }) => requiredFiles.length > 0),
    ).toBe(true);
    expect(output.trim().split("\n")).toEqual(expectedPackages);

    for (const entry of expectedPackages) {
      const [directory, expectedName] = entry.split("|");
      const manifest = JSON.parse(read(`${directory}/package.json`)) as {
        name: string;
      };
      expect(manifest.name).toBe(expectedName);
    }

    const verifier = read("scripts/verify-release-packages.mjs");
    expect(verifier).toContain(
      'import { releasePackages as publicPackages } from "./release/release-packages.mjs";',
    );
    expect(verifier).not.toContain("const publicPackages = [");
  });

  it("publishes stable packages directly to latest through OIDC and supports reruns", () => {
    const script = read("scripts/release/publish-release.sh");

    expect(script).toContain('source "$script_directory/package-set.sh"');
    expect(script).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(script).toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    expect(script).toContain('npm_registry_url="https://registry.npmjs.org/"');
    expect(script).toContain('npm "$@" --registry="$npm_registry_url"');
    expect(script).toContain(
      'npm_registry_command publish "./$package_directory" --access public --tag latest',
    );
    expect(script).toContain("Present: %s@%s (matching gitHead)");
    expect(script).not.toContain("npm dist-tag");
    expect(script).not.toContain("--otp");
    expect(script).not.toContain("npm whoami");
    expect(script).not.toContain("read -r -p");
  });

  it("forces npmjs when a package manager injects another npm registry", () => {
    const registry = execFileSync(
      "npm",
      ["config", "get", "registry", "--registry=https://registry.npmjs.org/"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_registry: "https://registry.yarnpkg.com",
        },
      },
    );

    expect(registry.trim()).toBe("https://registry.npmjs.org/");
  });

  it("keeps tag creation operator-driven and defers the GitHub Release", () => {
    const script = read("scripts/release/create-tag.sh");
    const manifest = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(script).toContain('git tag -a "$tag"');
    expect(script).toContain(
      'git push --quiet origin "refs/tags/$tag:refs/tags/$tag"',
    );
    expect(script).not.toContain("gh release");
    expect(manifest.scripts["release:create-tag"]).toBe(
      "bash scripts/release/create-tag.sh",
    );
    expect(manifest.scripts["release:pack"]).toBe(
      "bash scripts/release/check-packages.sh",
    );
    expect(manifest.scripts["release:publish"]).toBe(
      "bash scripts/release/publish-release.sh",
    );
  });

  it("documents trusted publishing setup and partial-release recovery", () => {
    const runbook = read("RELEASING.md");

    expect(runbook).toContain("security-and-release.yml");
    expect(runbook).toContain("GitHub environment named `npm`");
    expect(runbook).toContain("trusted publisher");
    expect(runbook).toContain("directly to the `latest` dist-tag");
    expect(runbook).toContain("partial release");
  });
});
