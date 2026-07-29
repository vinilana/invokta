import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contentRoot = join(appRoot, "src", "content", "docs");

const requiredRoutes = [
  "/",
  "/getting-started/installation/",
  "/getting-started/first-engine/",
  "/concepts/action-engines/",
  "/concepts/capabilities/",
  "/concepts/invocation-pipeline/",
  "/guides/execution-channels/",
  "/guides/deployment/",
  "/reference/core/",
  "/reference/cli/",
  "/reference/mcp/",
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
