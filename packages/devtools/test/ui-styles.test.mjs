import { describe, expect, it } from "vitest";

import { styles } from "../src/ui/styles.js";

describe("compact devtools styles", () => {
  it("uses functional hierarchy and readable compact controls", () => {
    expect(styles).not.toContain(".eyebrow");
    expect(styles).not.toContain("translateX(");
    expect(styles).not.toContain("transform: translateY(-1px)");
    expect(styles).toContain("--control-line:");
    expect(styles).toContain(".capability-sidebar-heading");
    expect(styles).toContain(".capability-search");
    expect(styles).toContain(".capability-choice-title");
    expect(styles).toContain(".capability-choice-id");
    expect(styles).toContain(".workspace-panel {");
    expect(styles).toContain(".schema-grid {");
    expect(styles).toContain(".schema-field {");
    expect(styles).toContain(".invoke-workspace .code-window pre.result");
    expect(styles).toContain(".schema-raw > summary::after");
    expect(styles).toMatch(/\.invoke-workspace \{[^}]*grid-template-columns/s);
    expect(styles).toContain('[role="region"]:focus-visible');
    expect(styles).toContain(".principal-row:focus-visible");
    expect(styles).toContain(".principals-header h2:focus-visible");
    expect(styles).toMatch(/details > summary \{[^}]*min-height: 2rem/s);
  });

  it("keeps the catalog vertically readable at compact widths", () => {
    const compact = styles.slice(styles.indexOf("@media (max-width: 44rem)"));

    expect(compact).toMatch(/\.capability-list \{[^}]*flex-direction: column/s);
    expect(compact).not.toMatch(/\.capability-list \{[^}]*overflow-x: auto/s);
    expect(compact).toMatch(/\.capability-list button \{[^}]*flex: 0 1 auto/s);
  });

  it("distributes diagnostics and identity workflows across the shared workspace", () => {
    expect(styles).toContain(".trace-header {");
    expect(styles).toContain(".trace-state--live");
    expect(styles).toMatch(
      /\.trace-payload-grid \{[^}]*grid-template-columns:[^;}]+/s,
    );
    expect(styles).toMatch(
      /\.doctor-sections \{[^}]*grid-template-columns:[^;}]+/s,
    );
    expect(styles).toContain(".doctor-actions {");
    expect(styles).toContain(".doctor-refresh {");
    expect(styles).toMatch(
      /\.principals-panel-body \{[^}]*grid-template-columns: repeat\(12,/s,
    );
    expect(styles).toMatch(
      /\.principals-list-section \{[^}]*grid-column: 1 \/ span 8/s,
    );
    expect(styles).toMatch(/\.principal-create \{[^}]*grid-column: 9 \/ -1/s);
    expect(styles).toContain(".principal-row-main {");
    expect(styles).toContain(".principal-state-grid {");

    const responsive = styles.slice(
      styles.indexOf("@media (max-width: 58rem)"),
    );
    expect(responsive).toMatch(
      /\.principals-panel-body \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s,
    );
    expect(responsive).toMatch(
      /\.doctor-sections \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s,
    );
    expect(responsive).toMatch(
      /\.trace-payload-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s,
    );
    expect(responsive).toMatch(/\.principal-create \{[^}]*grid-row: auto/s);
  });
});
