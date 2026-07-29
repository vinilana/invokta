import { describe, expect, it } from "vitest";

import { createCursorAgentRoutingEngine } from "../src/engine.js";

const expectedRoutes = [
  ["plan", "planner", "claude-opus-5", true],
  ["review", "reviewer", "claude-fable-5", true],
  ["complex-development", "complex-builder", "grok-4.5", false],
  ["debug", "debugger", "gpt-5.6-sol", false],
  ["documentation", "documenter", "gemini-3.6-flash", false],
  ["prototype-development", "prototyper", "composer-2.5-fast", false],
  ["simple-development", "simple-builder", "gpt-5.6-luna", false],
] as const;

describe("the Cursor agent routing engine example", () => {
  it.each(expectedRoutes)(
    "routes %s to the %s agent on %s",
    async (useCase, agentName, modelSelector, readOnly) => {
      const engine = createCursorAgentRoutingEngine();

      const result = await engine.invoke(
        "developer-work.route-cursor-task",
        { useCase },
        { source: "direct" },
      );

      expect(result).toMatchObject({
        catalogDate: "2026-07-28",
        useCase,
        agent: { name: agentName, readOnly },
        primaryModel: { selector: modelSelector },
      });
      expect(result.primaryModel.displayName).not.toBe("");
      expect(result.fallbackModel.selector).not.toBe(modelSelector);
      expect(result.rationale).not.toBe("");
    },
  );

  it("rejects a use case outside the routing contract", async () => {
    const engine = createCursorAgentRoutingEngine();

    await expect(
      engine.invoke("developer-work.route-cursor-task", {
        useCase: "write-sql" as never,
      }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});
