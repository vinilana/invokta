import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contentRoot = join(appRoot, "src", "content", "docs");
const repositoryRoot = join(appRoot, "..", "..");

const requiredRecipeRoutes = [
  "/recipes/atomic-capability-export/",
  "/recipes/capability-library/",
  "/recipes/dependency-injection/",
  "/recipes/domain-authorization/",
  "/recipes/capability-composition/",
  "/recipes/mcp-stdio-consumer/",
  "/recipes/external-provider/",
];

const packageReferences = [
  ["core", "@invokta/core"],
  ["cli", "@invokta/cli"],
  ["mcp", "@invokta/mcp"],
  ["tooling", "@invokta/tooling"],
  ["installer", "@invokta/installer"],
  ["deploy", "@invokta/deploy"],
  ["create-invokta-engine", "create-invokta-engine"],
];

const requiredRoutes = [
  "/",
  "/getting-started/installation/",
  "/getting-started/first-engine/",
  "/concepts/action-engines/",
  "/concepts/capabilities/",
  "/concepts/invocation-pipeline/",
  "/concepts/scope-and-limits/",
  "/guides/execution-channels/",
  "/guides/capability-packages/",
  "/guides/file-naming/",
  "/guides/http-authentication/",
  "/guides/capability-authorization/",
  "/guides/deployment/",
  "/examples/",
  "/recipes/",
  ...requiredRecipeRoutes,
  "/reference/",
  ...packageReferences.map(([route]) => `/reference/${route}/`),
  "/reference/errors/",
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(path) : path;
    }),
  );
  return files.flat();
}

function sourceRoute(path) {
  const extension = extname(path);
  const sourcePath = relative(contentRoot, path)
    .split(sep)
    .join("/")
    .slice(0, -extension.length);
  const segments = sourcePath.split("/");
  if (segments.at(-1) === "index") segments.pop();
  return `/${segments.filter(Boolean).join("/")}${segments.length ? "/" : ""}`;
}

async function discoverExampleDirectories() {
  const examplesRoot = join(repositoryRoot, "examples");
  const entries = await readdir(examplesRoot, { withFileTypes: true });
  const directories = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(examplesRoot, entry.name, "README.md"), "utf8");
      directories.push(entry.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return directories.sort();
}

async function discoverPublicPackages() {
  const packagesRoot = join(repositoryRoot, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"),
      );
      if (manifest.private !== true)
        packages.push({ directory: entry.name, manifest });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return packages.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
}

test("the docs app is an isolated Astro and Starlight application", async () => {
  const packageJson = JSON.parse(
    await readFile(join(appRoot, "package.json"), "utf8"),
  );

  assert.equal(packageJson.private, true);
  assert.ok(packageJson.dependencies?.astro);
  assert.ok(packageJson.dependencies?.["@astrojs/starlight"]);
  assert.equal(packageJson.scripts?.test, "node --test test/*.node.mjs");
  assert.ok(packageJson.scripts?.check.includes("astro check"));
  assert.ok(packageJson.scripts?.build.includes("astro build"));
  assert.ok(packageJson.scripts?.validate.includes("yarn run check"));
});

test("the initial public documentation routes are present", async () => {
  const files = (await collectFiles(contentRoot)).filter((path) =>
    [".md", ".mdx"].includes(extname(path)),
  );
  const routes = new Set(files.map(sourceRoute));

  for (const route of requiredRoutes) {
    assert.ok(routes.has(route), `Missing documentation route: ${route}`);
  }
});

test("root-relative links resolve to a documentation route", async () => {
  const files = (await collectFiles(contentRoot)).filter((path) =>
    [".md", ".mdx"].includes(extname(path)),
  );
  const routes = new Set(files.map(sourceRoute));
  const failures = [];

  for (const path of files) {
    const source = await readFile(path, "utf8");
    const links = [
      ...source.matchAll(/\]\((\/[^)#?]+)(?:#[^)]+)?\)/g),
      ...source.matchAll(/^\s+link:\s*['"]?(\/[^\s'"#]+)[^\n]*$/gm),
    ];
    for (const match of links) {
      const target = match[1].endsWith("/") ? match[1] : `${match[1]}/`;
      if (!routes.has(target)) {
        failures.push(`${relative(appRoot, path)} -> ${match[1]}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("the site reflects the current Action Engine value proposition", async () => {
  const home = await readFile(join(contentRoot, "index.mdx"), "utf8");
  const actionEngines = await readFile(
    join(contentRoot, "concepts", "action-engines.mdx"),
    "utf8",
  );

  assert.match(home, /durable asset/iu);
  assert.match(home, /delivery\s+paths/iu);
  assert.match(home, /^## What Invokta provides$/mu);
  assert.match(home, /\]\(\/examples\/\)/u);
  assert.match(actionEngines, /reviewed specification/iu);
  assert.match(actionEngines, /protocol upgrades/iu);
});

test("the examples catalog covers every documented repository example", async () => {
  const source = await readFile(
    join(contentRoot, "examples", "index.mdx"),
    "utf8",
  );

  const exampleDirectories = await discoverExampleDirectories();
  assert.ok(exampleDirectories.length > 0);

  for (const directory of exampleDirectories) {
    assert.match(
      source,
      new RegExp(
        `https://github\\.com/vinilana/invokta/tree/main/examples/${directory}`,
        "u",
      ),
      directory,
    );
  }
});

test("every public package has an installable API or command reference", async () => {
  const publicPackages = await discoverPublicPackages();
  assert.deepEqual(
    packageReferences.map(([, packageName]) => packageName).sort(),
    publicPackages.map(({ manifest }) => manifest.name),
  );

  for (const [route, packageName] of packageReferences) {
    const source = await readFile(
      join(contentRoot, "reference", `${route}.mdx`),
      "utf8",
    );
    assert.match(source, new RegExp(packageName.replace("/", "\\/"), "u"));
    assert.match(source, /^## Install$/mu, route);
    assert.match(source, /^## (?:API|Commands|Public surface)$/mu, route);
  }
});

test("every public package binary is documented", async () => {
  const publicPackages = await discoverPublicPackages();

  for (const { directory, manifest } of publicPackages) {
    const binaries =
      typeof manifest.bin === "string"
        ? [manifest.name]
        : Object.keys(manifest.bin ?? {});
    if (binaries.length === 0) continue;

    const source = await readFile(
      join(contentRoot, "reference", `${directory}.mdx`),
      "utf8",
    );
    for (const binary of binaries) {
      assert.match(source, new RegExp(`\\b${binary}\\b`, "u"), directory);
    }
  }
});

test("all required routes are reachable from the sidebar", async () => {
  const config = await readFile(join(appRoot, "astro.config.mjs"), "utf8");

  for (const route of requiredRoutes) {
    const slug = route === "/" ? "index" : route.replace(/^\/|\/$/gu, "");
    assert.match(config, new RegExp(`slug: ["']${slug}["']`, "u"), route);
  }
});

test("an empty installer registry is documented as read-only", async () => {
  const registry = JSON.parse(
    await readFile(
      join(
        repositoryRoot,
        "packages",
        "installer",
        "registry",
        "capabilities.json",
      ),
      "utf8",
    ),
  );
  if (registry.entries.length !== 0) return;

  const reference = await readFile(
    join(contentRoot, "reference", "installer.mdx"),
    "utf8",
  );
  const installation = await readFile(
    join(contentRoot, "getting-started", "installation.mdx"),
    "utf8",
  );
  const rootReadme = await readFile(join(repositoryRoot, "README.md"), "utf8");

  for (const [name, source] of [
    ["installer reference", reference],
    ["installation guide", installation],
    ["root README", rootReadme],
  ]) {
    assert.match(source, /read-only/iu, name);
  }
  assert.match(reference, /does not\s+install/iu);
});

test("the capability package guide covers authoring, publishing, and consuming", async () => {
  const source = await readFile(
    join(contentRoot, "guides", "capability-packages.mdx"),
    "utf8",
  );
  const requiredSymbols = [
    "defineExportedCapability",
    "defineCapabilityLibrary",
    "importCapability",
    "importCapabilities",
    "composeCapabilities",
    "isComposedCapabilities",
    "check-capabilities",
  ];

  for (const symbol of requiredSymbols) {
    assert.match(source, new RegExp(`\\b${symbol}\\b`, "u"), symbol);
  }
  assert.match(source, /package\.json/iu);
  assert.match(source, /CAPABILITY_COMPOSITION_INVALID/u);
});

test("the file naming guide defines engine-owned naming patterns", async () => {
  const source = await readFile(
    join(contentRoot, "guides", "file-naming.mdx"),
    "utf8",
  );

  const requiredPatterns = [
    "src/capabilities/<verb>-<object>.ts",
    "src/domain/<concept>.ts",
    "src/application/ports.ts",
    "src/infrastructure/<provider>-<port-role>.ts",
    "src/engine.ts",
    "<subject>.test.ts",
  ];

  for (const pattern of requiredPatterns) {
    assert.ok(source.includes(pattern), pattern);
  }
  assert.match(source, /kebab-case/iu);
  assert.match(source, /service\.ts/iu);
  assert.match(source, /does not (?:inspect|enforce)/iu);
});

test("example files follow the documented filename grammar", async () => {
  const examplesRoot = join(repositoryRoot, "examples");
  const files = (await collectFiles(examplesRoot)).filter((path) => {
    const segments = relative(examplesRoot, path).split(sep);
    return (
      (segments.includes("src") || segments.includes("test")) &&
      extname(path) === ".ts"
    );
  });
  const genericNames = new Set([
    "common.ts",
    "helpers.ts",
    "provider.ts",
    "service.ts",
    "services.ts",
    "types.ts",
    "utils.ts",
  ]);
  const failures = [];

  for (const path of files) {
    const name = basename(path);
    const displayPath = relative(repositoryRoot, path).split(sep).join("/");
    const segments = relative(examplesRoot, path).split(sep);
    const filenamePattern = segments.includes("src")
      ? /^[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/u
      : /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.test)?\.ts$/u;
    if (!filenamePattern.test(name)) {
      failures.push(`${displayPath}: use lowercase kebab-case`);
    }
    if (genericNames.has(name)) {
      failures.push(`${displayPath}: name the owned responsibility`);
    }

    if (segments.at(-2) !== "capabilities") continue;
    const source = await readFile(path, "utf8");
    if (
      !/\bdefineCapability\b/u.test(source) &&
      !/-contract\.ts$/u.test(name)
    ) {
      failures.push(
        `${displayPath}: shared capability support must use -contract.ts`,
      );
    }
  }

  assert.deepEqual(failures, []);
});

test("recipes provide runnable commands, verification, and full examples", async () => {
  const files = (await collectFiles(contentRoot)).filter((path) =>
    [".md", ".mdx"].includes(extname(path)),
  );
  const recipeFiles = files.filter((path) =>
    requiredRecipeRoutes.includes(sourceRoute(path)),
  );

  assert.equal(recipeFiles.length, requiredRecipeRoutes.length);
  for (const path of recipeFiles) {
    const source = await readFile(path, "utf8");
    assert.match(source, /^## Run it$/mu, relative(appRoot, path));
    assert.match(source, /^## Verify it$/mu, relative(appRoot, path));
    assert.match(
      source,
      /https:\/\/github\.com\/vinilana\/invokta\/tree\/main\/examples\//u,
      relative(appRoot, path),
    );
  }
});

test("public copy avoids unsupported hype and prohibited phrasing", async () => {
  const files = (await collectFiles(contentRoot)).filter((path) =>
    [".md", ".mdx"].includes(extname(path)),
  );
  const prohibited = [
    /revolutionary/iu,
    /game[- ]changer/iu,
    /10x/iu,
    /effortless/iu,
    /unlock (?:the )?power/iu,
    /supercharge/iu,
  ];
  const failures = [];

  for (const path of files) {
    const source = await readFile(path, "utf8");
    for (const pattern of prohibited) {
      if (pattern.test(source)) {
        failures.push(`${relative(appRoot, path)} matches ${pattern}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});
