import { readdir, readFile } from "node:fs/promises";

import { expect, it } from "vitest";

const repositoryRoot = new URL("../../../", import.meta.url);
const approvedSdkVersion = "1.30.0";
const sdkPackageName = "@modelcontextprotocol/sdk";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly resolutions?: Readonly<Record<string, string>>;
}

async function readManifest(url: URL): Promise<PackageManifest> {
  return JSON.parse(await readFile(url, "utf8")) as PackageManifest;
}

async function readWorkspaceManifests(
  directory: "examples" | "packages",
): Promise<PackageManifest[]> {
  const workspaceDirectories = (
    await readdir(new URL(`${directory}/`, repositoryRoot), {
      withFileTypes: true,
    })
  ).filter((entry) => entry.isDirectory());

  return await Promise.all(
    workspaceDirectories.map((entry) =>
      readManifest(
        new URL(`${directory}/${entry.name}/package.json`, repositoryRoot),
      ),
    ),
  );
}

it("pins every official MCP SDK consumer to the approved exact version", async () => {
  const manifests = (
    await Promise.all([
      readWorkspaceManifests("packages"),
      readWorkspaceManifests("examples"),
    ])
  ).flat();
  const declaredVersions = manifests.flatMap((manifest) =>
    [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ].flatMap((group) =>
      group?.[sdkPackageName] === undefined ? [] : [group[sdkPackageName]],
    ),
  );

  expect(declaredVersions.length).toBeGreaterThan(0);
  expect(new Set(declaredVersions)).toEqual(new Set([approvedSdkVersion]));
});

it("does not force the superseded Hono compatibility resolution", async () => {
  const rootManifest = await readManifest(
    new URL("package.json", repositoryRoot),
  );

  expect(rootManifest.resolutions?.["@hono/node-server"]).toBeUndefined();
});
