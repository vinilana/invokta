import type { HarnessDetectionSnapshot } from "@invokta/installer-core";
import { describe, expect, it, vi } from "vitest";
import type { InteractivePrompter } from "../src/interactive-prompter.js";
import { runReadOnlyInventory } from "../src/read-only-inventory.js";

function prompter(selection: string): {
  readonly port: InteractivePrompter;
  readonly note: ReturnType<typeof vi.fn>;
  readonly select: ReturnType<typeof vi.fn>;
  readonly outro: ReturnType<typeof vi.fn>;
} {
  const note = vi.fn();
  const select = vi.fn(async () => ({
    kind: "submitted" as const,
    value: selection,
  }));
  const outro = vi.fn();
  return {
    port: {
      intro: vi.fn(),
      outro,
      cancel: vi.fn(),
      autocomplete: vi.fn(),
      select: select as unknown as InteractivePrompter["select"],
      multiselect: vi.fn(),
      note,
      confirm: vi.fn(),
      spinner: vi.fn(),
      log: vi.fn(),
    },
    note,
    select,
    outro,
  };
}

const emptySnapshot: HarnessDetectionSnapshot = {
  homeDirectory: "/users/tester",
  surfaces: [],
  targets: [],
};

describe("read-only interactive inventory", () => {
  it("shows the stable no-harness notice, waits for dismissal, and exits zero", async () => {
    const interaction = prompter("dismiss");

    const exitCode = await runReadOnlyInventory(
      emptySnapshot,
      interaction.port,
    );

    expect(exitCode).toBe(0);
    expect(interaction.note).toHaveBeenCalledWith(
      "No supported AI harness was detected.",
      "Harness inventory",
    );
    expect(interaction.select).toHaveBeenCalledWith({
      message: "No supported harnesses were found.",
      options: [{ value: "dismiss", label: "Dismiss" }],
    });
    expect(interaction.outro).toHaveBeenCalledWith("No changes were made.");
  });

  it("offers each coalesced target once and renders one result with one reload hint", async () => {
    const interaction = prompter("antigravity");
    const reloadHint = "Refresh the shared Antigravity MCP configuration.";
    const snapshot: HarnessDetectionSnapshot = {
      homeDirectory: "/users/tester",
      surfaces: [],
      targets: [
        {
          id: "antigravity",
          displayName: "Antigravity (AGY CLI + IDE)",
          surfaceIds: ["antigravity-cli", "antigravity-ide"],
          evidence: "installed",
          executables: [
            {
              candidate: "agy",
              path: "/fixture/bin/agy",
              identity: {
                device: 7,
                inode: 11,
                realPath: "/fixture/bin/agy",
              },
            },
            {
              candidate: "antigravity",
              path: "/fixture/bin/antigravity",
              identity: {
                device: 7,
                inode: 12,
                realPath: "/fixture/bin/antigravity",
              },
            },
          ],
          configuration: {
            kind: "absent",
            path: "/users/tester/.gemini/config/mcp_config.json",
          },
          eligible: true,
          mayCreateConfiguration: true,
          reloadHint,
        },
      ],
    };

    const exitCode = await runReadOnlyInventory(snapshot, interaction.port);

    expect(exitCode).toBe(0);
    const selection = interaction.select.mock.calls[0]?.[0];
    expect(selection.options).toEqual([
      {
        value: "antigravity",
        label: "Antigravity (AGY CLI + IDE)",
        hint: "installed",
      },
      { value: "dismiss", label: "Done" },
    ]);
    expect(
      selection.options.filter(
        ({ value }: { readonly value: string }) => value === "antigravity",
      ),
    ).toHaveLength(1);
    const resultText = interaction.note.mock.calls[1]?.[0] as string;
    expect(resultText).toContain("antigravity-cli, antigravity-ide");
    expect(resultText).toContain(
      "Configuration: /users/tester/.gemini/config/mcp_config.json",
    );
    expect(resultText.match(new RegExp(reloadHint, "gu"))).toHaveLength(1);
    expect(interaction.outro).toHaveBeenCalledWith(
      "Read-only inventory complete. No changes were made.",
    );
  });

  it("maps prompt cancellation without attempting another interaction", async () => {
    const interaction = prompter("dismiss");
    interaction.select.mockResolvedValueOnce({ kind: "cancelled" });

    const exitCode = await runReadOnlyInventory(
      emptySnapshot,
      interaction.port,
    );

    expect(exitCode).toBe(130);
    expect(interaction.port.cancel).toHaveBeenCalledWith(
      "Installation was cancelled.",
    );
    expect(interaction.outro).not.toHaveBeenCalled();
  });

  it("shows blocked target evidence as disabled instead of reporting no harness", async () => {
    const interaction = prompter("dismiss");
    const snapshot: HarnessDetectionSnapshot = {
      homeDirectory: "/users/tester",
      surfaces: [],
      targets: [
        {
          id: "codex",
          displayName: "Codex",
          surfaceIds: ["codex"],
          evidence: "blocked",
          executables: [],
          configuration: {
            kind: "blocked",
            code: "HARNESS_CONFIG_UNSAFE",
          },
          eligible: false,
          mayCreateConfiguration: false,
          reloadHint: "Restart Codex.",
        },
      ],
    };

    const exitCode = await runReadOnlyInventory(snapshot, interaction.port);

    expect(exitCode).toBe(0);
    expect(interaction.note).not.toHaveBeenCalledWith(
      "No supported AI harness was detected.",
      "Harness inventory",
    );
    expect(interaction.select).toHaveBeenCalledWith({
      message: "Inspect a detected target.",
      options: [
        {
          value: "codex",
          label: "Codex",
          hint: "HARNESS_CONFIG_UNSAFE",
          disabled: true,
        },
        { value: "dismiss", label: "Done" },
      ],
    });
  });
});
