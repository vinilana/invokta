import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contentRoot = join(appRoot, "src", "content", "docs");
const repositoryRoot = join(appRoot, "..", "..");
const actionEngineDiagramPath = join(
  appRoot,
  "public",
  "images",
  "how-an-action-engine-works.svg",
);

test("the docs expose concrete use cases by company area", async () => {
  const useCases = await readFile(
    join(contentRoot, "use-cases", "index.mdx"),
    "utf8",
  );
  const home = await readFile(join(contentRoot, "index.mdx"), "utf8");
  const config = await readFile(join(appRoot, "astro.config.mjs"), "utf8");
  const rootReadme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  const actionEngineDiagram = await readFile(actionEngineDiagramPath, "utf8");

  for (const heading of [
    "Content and creative",
    "Engineering",
    "Product and design",
    "Marketing",
    "Sales",
    "Healthcare operations",
    "People and recruiting",
    "Support and customer success",
    "Operations",
  ]) {
    assert.match(useCases, new RegExp(`^## ${heading}$`, "mu"), heading);
  }

  for (const capabilityId of [
    "video.transcribe-source",
    "video.apply-edit",
    "carousel.prepare-series",
    "carousel.render-series",
    "engineering.prepare-implementation",
    "product.prepare-discovery-brief",
    "marketing.prepare-campaign",
    "sales.prepare-proposal",
    "sales.render-proposal",
    "appointments.list-valid-slots",
    "appointments.schedule",
    "recruiting.screen-candidate",
    "recruiting.record-screening",
    "recruiting.notify-review",
    "support.classify-ticket",
    "operations.prepare-incident-handoff",
  ]) {
    assert.ok(useCases.includes(capabilityId), capabilityId);
  }

  for (const integration of [
    "ElevenLabs STT",
    "Cartesia TTS",
    "GPT Image 2.0",
    "Seedance 2.0",
    "Google Calendar",
    "Slack notification",
  ]) {
    assert.match(useCases, new RegExp(integration, "u"), integration);
  }

  assert.match(useCases, /illustrative domain contracts/iu);
  assert.match(useCases, /does not become\s+a workflow engine/iu);
  assert.match(config, /slug: ["']use-cases["']/u);

  assert.match(home, /engineering\.prepare-implementation/u);
  assert.match(home, /Video Production Engine/u);
  assert.match(home, /customer-specific commercial proposal/u);
  assert.match(home, /Google Calendar/u);
  assert.match(home, /persist screening evidence/u);
  assert.match(home, /\]\(\/use-cases\//u);
  assert.match(home, /\/images\/how-an-action-engine-works\.svg/u);

  assert.match(
    rootReadme,
    /apps\/docs\/src\/content\/docs\/use-cases\/index\.mdx/u,
  );
  assert.match(rootReadme, /Video Production Engine/u);
  assert.match(rootReadme, /Social Carousel Engine/u);
  assert.match(rootReadme, /Commercial Proposal Engine/u);
  assert.match(rootReadme, /Appointment Scheduling Engine/u);
  assert.match(rootReadme, /Recruiting and Selection Engine/u);
  assert.match(rootReadme, /video\.apply-edit/u);
  assert.match(rootReadme, /appointments\.schedule/u);
  assert.match(
    rootReadme,
    /apps\/docs\/public\/images\/how-an-action-engine-works\.svg/u,
  );

  for (const label of ["Claude Code", "Codex", "Hermes", "CLI"]) {
    assert.match(actionEngineDiagram, new RegExp(label, "u"), label);
  }
  assert.match(actionEngineDiagram, /Action Engine/u);
  assert.match(actionEngineDiagram, /returns a validated result/iu);

  assert.doesNotMatch(home, /engineering\.create-bug-fix-spec/u);
  assert.doesNotMatch(rootReadme, /engineering\.create-bug-fix-spec/u);
});
