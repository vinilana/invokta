import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cursorUseCases } from "../src/domain/routing.js";
import { createCursorAgentRoutingEngine } from "../src/engine.js";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));

describe("the Cursor project configuration", () => {
  it.each(cursorUseCases)(
    "pins the %s route to its recommended custom subagent model",
    async (useCase) => {
      const engine = createCursorAgentRoutingEngine();
      const route = await engine.invoke(
        "developer-work.route-cursor-task",
        { useCase },
        { source: "direct" },
      );

      const definition = await readFile(
        `${exampleRoot}/cursor-config/agents/${route.agent.name}.md`,
        "utf8",
      );

      expect(definition).toContain(`name: ${route.agent.name}`);
      expect(definition).toContain(`model: ${route.primaryModel.selector}`);
      expect(definition).toContain(`readonly: ${String(route.agent.readOnly)}`);
    },
  );

  it("teaches the parent agent to consult the engine before delegation", async () => {
    const rule = await readFile(
      `${exampleRoot}/cursor-config/rules/model-routing.mdc`,
      "utf8",
    );

    expect(rule).toContain("developer-work.route-cursor-task");
    for (const useCase of cursorUseCases) {
      expect(rule).toContain(`\`${useCase}\``);
    }
  });

  it("registers the stdio engine without duplicating routing rules", async () => {
    const configuration = JSON.parse(
      await readFile(`${exampleRoot}/cursor-config/mcp.json`, "utf8"),
    ) as {
      readonly mcpServers: Readonly<
        Record<string, { readonly command: string; readonly args: string[] }>
      >;
    };

    expect(configuration.mcpServers["cursor-agent-routing"]).toEqual({
      command: "node",
      args: ["examples/cursor-agent-routing-engine/dist/mcp-stdio.js"],
    });
  });
});
