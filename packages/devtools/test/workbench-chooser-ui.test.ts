import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { attachedStyles } from "../src/ui/attached-styles.js";
import { workbenchChoices } from "../src/ui/chooser-app.js";
import {
  mountedWorkbench,
  workbenchApiBase,
  workbenchLabels,
  workbenchPaths,
} from "../src/ui/workbench-chrome.js";

const uiDirectory = fileURLToPath(new URL("../src/ui/", import.meta.url));

function readUi(fileName: string): string {
  return readFileSync(`${uiDirectory}/${fileName}`, "utf8");
}

describe("workbench chooser", () => {
  it("offers exactly the two mounted workbenches", () => {
    expect(workbenchChoices.map((choice) => choice.workbench)).toStrictEqual([
      "mcp",
      "cli",
    ]);
    expect(workbenchPaths).toStrictEqual({ mcp: "/mcp", cli: "/cli" });
    expect(workbenchLabels).toStrictEqual({ mcp: "MCP", cli: "CLI" });
    for (const choice of workbenchChoices) {
      expect(choice.flag).toBe(`invokta-devtools open --${choice.workbench}`);
    }
  });

  it("keeps the chooser inert and points at the workspace command", () => {
    const chooser = readUi("chooser-app.ts");

    expect(chooser).toContain("Choose a workbench");
    expect(chooser).toContain("invokta-devtools serve dist/engine.js");
    expect(chooser).toContain("or yarn devtools inside an engine repo");
    expect(chooser).not.toMatch(/fetch\(|localStorage|sessionStorage/);
    expect(chooser).not.toContain('el("style"');
  });

  it("switches workbenches with same-origin links, not a rebuild", () => {
    const chrome = readUi("workbench-chrome.ts");

    expect(chrome).toContain('class: "att-switch"');
    expect(chrome).toContain('"aria-label": "Workbench"');
    expect(chrome).toContain('"aria-current": "page"');
    expect(chrome).toContain("href: workbenchPaths[name]");
  });

  it("reads its mount from the document the launcher served", () => {
    const launched = {
      body: { dataset: { invoktaApi: "/api/cli", invoktaWorkbench: "cli" } },
    } as unknown as Document;
    const standalone = { body: { dataset: {} } } as unknown as Document;

    expect(workbenchApiBase(launched)).toBe("/api/cli");
    expect(mountedWorkbench(launched)).toBe("cli");
    // A single-workbench server declares nothing and has nothing to switch to.
    expect(workbenchApiBase(standalone)).toBe("/api");
    expect(mountedWorkbench(standalone)).toBeUndefined();
  });

  it("styles the chooser cards and the workbench switch", () => {
    expect(attachedStyles).toContain(".att-choices {");
    expect(attachedStyles).toContain(".att-choice {");
    expect(attachedStyles).toContain(".att-choice:hover {");
    expect(attachedStyles).toContain(".att-switch {");
    expect(attachedStyles).toContain(".att-switch-option {");
    expect(attachedStyles).toContain('.att-switch-option[aria-current="page"]');
    expect(attachedStyles).toContain(".att-brand-link {");
  });
});
