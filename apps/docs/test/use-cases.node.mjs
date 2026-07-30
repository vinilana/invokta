import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contentRoot = join(appRoot, "src", "content", "docs");

test("the docs expose use cases by company area", async () => {
  const useCases = await readFile(
    join(contentRoot, "use-cases", "index.mdx"),
    "utf8",
  );
  const home = await readFile(join(contentRoot, "index.mdx"), "utf8");
  const config = await readFile(join(appRoot, "astro.config.mjs"), "utf8");

  for (const heading of [
    "Engineering",
    "Product and design",
    "Marketing",
    "Sales",
    "Support and customer success",
    "Operations",
  ]) {
    assert.match(useCases, new RegExp(`^## ${heading}$`, "mu"), heading);
  }

  for (const capabilityId of [
    "engineering.prepare-implementation",
    "product.prepare-discovery-brief",
    "marketing.prepare-campaign",
    "sales.prepare-account-brief",
    "support.classify-ticket",
    "operations.prepare-incident-handoff",
  ]) {
    assert.ok(useCases.includes(capabilityId), capabilityId);
  }

  assert.match(useCases, /illustrative domain contracts/iu);
  assert.match(config, /slug: ["']use-cases["']/u);
  assert.match(home, /engineering\.prepare-implementation/u);
  assert.match(home, /\]\(\/use-cases\//u);
  assert.doesNotMatch(home, /engineering\.create-bug-fix-spec/u);
});
