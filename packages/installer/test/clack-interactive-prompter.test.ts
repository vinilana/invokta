import { beforeEach, describe, expect, it, vi } from "vitest";

const clack = vi.hoisted(() => {
  const cancelValue = Symbol("cancel");
  const spinnerResult = {
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
    isCancelled: false,
  };
  return {
    cancelValue,
    spinnerResult,
    autocomplete: vi.fn(),
    cancel: vi.fn(),
    confirm: vi.fn(),
    intro: vi.fn(),
    isCancel: vi.fn((value: unknown) => value === cancelValue),
    log: {
      error: vi.fn(),
      info: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
    multiselect: vi.fn(),
    note: vi.fn(),
    outro: vi.fn(),
    select: vi.fn(),
    spinner: vi.fn(() => spinnerResult),
  };
});

vi.mock("@clack/prompts", () => clack);

import { createClackInteractivePrompter } from "../src/clack-interactive-prompter.js";

describe("Clack InteractivePrompter adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clack.spinner.mockReturnValue(clack.spinnerResult);
  });

  it("maps submitted prompt values without exposing Clack values", async () => {
    clack.autocomplete.mockResolvedValue("support-engine");
    clack.select.mockResolvedValue("install");
    clack.multiselect.mockResolvedValue(["codex", "hermes"]);
    clack.confirm.mockResolvedValue(true);
    const prompter = createClackInteractivePrompter();
    const options = [
      { value: "support-engine", label: "Support Engine", hint: "support" },
    ] as const;

    await expect(
      prompter.autocomplete({
        message: "Choose a capability",
        options,
        maxItems: 8,
        placeholder: "Search",
      }),
    ).resolves.toEqual({ kind: "submitted", value: "support-engine" });
    await expect(
      prompter.select({ message: "Choose an action", options }),
    ).resolves.toEqual({ kind: "submitted", value: "install" });
    await expect(
      prompter.multiselect({ message: "Choose targets", options }),
    ).resolves.toEqual({
      kind: "submitted",
      value: ["codex", "hermes"],
    });
    await expect(prompter.confirm("Apply changes?")).resolves.toEqual({
      kind: "submitted",
      value: true,
    });

    expect(clack.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ required: true }),
    );
    expect(clack.confirm).toHaveBeenCalledWith({
      message: "Apply changes?",
      initialValue: false,
    });
    expect(clack.isCancel).toHaveBeenCalledTimes(4);
  });

  it.each(["autocomplete", "select", "multiselect", "confirm"] as const)(
    "maps %s cancellation before narrowing the value",
    async (method) => {
      clack[method].mockResolvedValue(clack.cancelValue);
      const prompter = createClackInteractivePrompter();
      const options = [{ value: "value", label: "Value" }] as const;

      const result =
        method === "confirm"
          ? await prompter.confirm("Continue?")
          : await prompter[method]({ message: "Choose", options });

      expect(result).toEqual({ kind: "cancelled" });
      expect(clack.isCancel).toHaveBeenCalledWith(clack.cancelValue);
    },
  );

  it("delegates session, note, log, and spinner rendering", () => {
    const prompter = createClackInteractivePrompter();

    prompter.intro("Invokta installer");
    prompter.note("Review", "Planned changes");
    prompter.log("warn", "One target is blocked.");
    const spinner = prompter.spinner();
    spinner.start("Detecting harnesses");
    spinner.message("Inspecting configuration");
    spinner.stop("Detection complete");
    spinner.error("Detection failed");
    spinner.cancel("Detection cancelled");
    spinner.clear();
    prompter.outro("Done");
    prompter.cancel("Cancelled");

    expect(clack.intro).toHaveBeenCalledWith("Invokta installer");
    expect(clack.note).toHaveBeenCalledWith("Review", "Planned changes");
    expect(clack.log.warn).toHaveBeenCalledWith("One target is blocked.");
    expect(clack.spinner).toHaveBeenCalledTimes(1);
    expect(clack.spinnerResult.start).toHaveBeenCalledWith(
      "Detecting harnesses",
    );
    expect(clack.spinnerResult.message).toHaveBeenCalledWith(
      "Inspecting configuration",
    );
    expect(clack.spinnerResult.stop).toHaveBeenCalledWith("Detection complete");
    expect(clack.spinnerResult.error).toHaveBeenCalledWith("Detection failed");
    expect(clack.spinnerResult.cancel).toHaveBeenCalledWith(
      "Detection cancelled",
    );
    expect(clack.spinnerResult.clear).toHaveBeenCalledTimes(1);
    expect(clack.outro).toHaveBeenCalledWith("Done");
    expect(clack.cancel).toHaveBeenCalledWith("Cancelled");
  });
});
