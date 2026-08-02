import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const pagePath = fileURLToPath(new URL("../web/index.html", import.meta.url));
const page = readFileSync(pagePath, "utf8");
const script = page.slice(
  page.indexOf("<script>") + "<script>".length,
  page.indexOf("</script>"),
);

function escapeFunction(): (value: unknown) => string {
  const source = script.slice(
    script.indexOf("function esc(value)"),
    script.indexOf("function reasonText"),
  );
  return runInNewContext(`${source}; esc`) as (value: unknown) => string;
}

describe("console page", () => {
  it("escapes every character that could close an attribute or a tag", () => {
    const esc = escapeFunction();

    expect(esc('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(esc("a & b")).toBe("a &amp; b");
    expect(esc("it's")).toBe("it&#39;s");
    expect(esc(undefined)).toBe("");
  });

  /**
   * These build plain strings, never markup. Their call sites are checked
   * instead, which is where the escaping actually has to happen.
   */
  const plainTextHelpers = [
    "reasonText",
    "previewText",
    "commandOf",
    "rowMeta",
    "cellText",
  ];

  /**
   * True when the interpolation sits inside a template literal that is
   * building markup, which is the only place escaping matters. A literal that
   * only assembles a search string or a value handed to `kv` — which escapes
   * on its own — opens no tag.
   */
  function insideMarkup(index: number): boolean {
    const literalStart = script.lastIndexOf("`", index);
    if (literalStart === -1) return false;
    return script.slice(literalStart, index).includes("<");
  }

  it("escapes every call to a plain-text helper", () => {
    for (const helper of plainTextHelpers) {
      const unescaped = [
        ...script.matchAll(
          new RegExp(`\\$\\{(?:(?!esc\\()[^}])*\\b${helper}\\(`, "gu"),
        ),
      ].map(([match]) => match);

      expect(unescaped, helper).toEqual([]);
    }
  });

  it("routes every manifest-supplied value in markup through the escaper", () => {
    const risky = [
      ...script.matchAll(
        /\$\{(?!esc\()(?:[A-Za-z]+[.?]+)*(?:title|description|serverName|displayName|manifestPath|directory|entrypoint|configPath|command|url|reason|code|path)\b/gu,
      ),
    ]
      .filter((match) => insideMarkup(match.index))
      .map(([match]) => match);

    expect(risky).toEqual([]);
  });

  it("proves the markup detector reacts to an unescaped value", () => {
    const marker = script.indexOf('<span class="row-title">');

    expect(marker).toBeGreaterThan(-1);
    expect(insideMarkup(marker + 24)).toBe(true);
    const searchLiteral = script.indexOf(
      ["$", "{engine.id} $", "{engine.title}"].join(""),
    );
    expect(searchLiteral).toBeGreaterThan(-1);
    expect(insideMarkup(searchLiteral)).toBe(false);
  });

  it("sends no request before the confirmation dialog is accepted", () => {
    const propose = script.slice(
      script.indexOf("function propose("),
      script.indexOf("function commandOf("),
    );
    const apply = script.slice(
      script.indexOf("async function applyPending()"),
      script.indexOf("/* ---------- wiring ---------- */"),
    );

    expect(propose).not.toContain("/api/action");
    expect(propose).toContain("state.confirm =");
    expect(apply).toContain("/api/action");
    expect(apply).toContain("if (!pending || state.applying) return;");
  });

  it("keeps the session token out of the document and off every log", () => {
    expect(page).not.toContain("console.log");
    expect(page).not.toMatch(/localStorage|sessionStorage|document\.cookie/u);
    expect(script).toContain(
      'new URLSearchParams(location.search).get("token")',
    );
  });

  it("loads no external origin", () => {
    expect(page).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/u);
    expect(page).not.toMatch(/<link\b|<img\b|<iframe\b|<script\s+src=/u);
  });
});
