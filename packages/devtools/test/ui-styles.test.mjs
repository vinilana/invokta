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
    expect(styles).toMatch(/\.invoke-workspace \{[^}]*grid-template-columns/s);
    expect(styles).toContain('[role="region"]:focus-visible');
    expect(styles).toContain(".principal-row:focus-visible");
    expect(styles).toContain(".principals-panel-body > h2:focus-visible");
    expect(styles).toMatch(/details > summary \{[^}]*min-height: 2rem/s);
  });

  it("keeps the catalog vertically readable at compact widths", () => {
    const compact = styles.slice(styles.indexOf("@media (max-width: 44rem)"));

    expect(compact).toMatch(/\.capability-list \{[^}]*flex-direction: column/s);
    expect(compact).not.toMatch(/\.capability-list \{[^}]*overflow-x: auto/s);
    expect(compact).toMatch(/\.capability-list button \{[^}]*flex: 0 1 auto/s);
  });
});
