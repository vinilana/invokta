import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessDetectionSnapshot } from "../src/harness-detection.js";
import type {
  InteractivePrompter,
  MultiselectPrompt,
  SelectPrompt,
} from "../src/interactive-prompter.js";
import { runManagementSession } from "../src/management-session.js";
import {
  installDescriptorAcrossTargets,
  type MutationCoordinatorDependencies,
  mutateDescriptorAcrossTargets,
} from "../src/mutation-coordinator.js";
import { createNodeFileSystem } from "../src/node-file-system.js";
import { captureProcessOwnershipIdentity } from "../src/ownership-identity.js";
import type { CapabilityInstallDescriptor } from "../src/registry.js";
import { createRemoteInstallDescriptor } from "../src/remote-install-source.js";
import { configurationTargetAdapters } from "../src/target-adapters.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function descriptor(name = "brain"): CapabilityInstallDescriptor {
  return createRemoteInstallDescriptor({
    serverName: name,
    url: `http://127.0.0.1:3100/e/${name}/mcp`,
  });
}

function fixture() {
  const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-many-"));
  temporaryDirectories.push(homeDirectory);
  const paths = {
    codex: join(homeDirectory, ".codex/config.toml"),
    cursor: join(homeDirectory, ".cursor/mcp.json"),
    state: join(homeDirectory, ".local/state/invokta/installer.json"),
  };
  const target = (id: "codex" | "cursor", displayName: string) => ({
    id,
    displayName,
    surfaceIds: [],
    evidence: "installed" as const,
    executables: [],
    configuration: { kind: "absent" as const, path: paths[id] },
    eligible: true,
    mayCreateConfiguration: true,
    reloadHint: `Reload ${displayName}.`,
  });
  const snapshot: HarnessDetectionSnapshot = {
    homeDirectory,
    surfaces: [],
    targets: [target("codex", "Codex"), target("cursor", "Cursor")],
  };
  let clock = 0;
  let token = 0;
  const dependencies: MutationCoordinatorDependencies = {
    adapters: configurationTargetAdapters,
    ownership: captureProcessOwnershipIdentity(),
    environment: { get: () => undefined },
    fileSystem: createNodeFileSystem(),
    lock: {
      clock: {
        monotonicNow: () => clock,
        now: () => Date.parse("2026-09-05T12:00:00.000Z") + clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      },
      processId: process.pid,
      randomBytes: (length) => new Uint8Array(length).fill(++token),
    },
    now: () => "2026-09-05T12:00:00.000Z",
  };
  const resolveExecutable = vi.fn(async () => undefined);
  return {
    paths,
    dependencies,
    snapshot,
    resolveExecutable,
    install: async (
      entry = descriptor(),
      targetIds: readonly ("codex" | "cursor")[] = ["codex", "cursor"],
    ) => {
      const results = await installDescriptorAcrossTargets({
        dependencies,
        descriptor: entry,
        snapshot,
        targetIds,
      });
      expect(results).toEqual(
        targetIds.map((targetId) => ({ targetId, outcome: "installed" })),
      );
    },
    state: () =>
      JSON.parse(readFileSync(paths.state, "utf8")) as {
        installations: Record<string, { entryId: string; targetId: string }>;
      },
    remove: (prompter: InteractivePrompter) =>
      runManagementSession({
        action: "remove",
        dependencies,
        prompter,
        registry: { schemaVersion: 1, entries: [] },
        resolveExecutable,
        snapshot,
      }),
  };
}

type Selection =
  | "all"
  | "none"
  | "cancelled"
  | ((
      options: readonly { value: string; label: string }[],
    ) => readonly string[]);

function prompter(
  selection: Selection = "all",
  confirmation: boolean | "cancelled" = true,
): InteractivePrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    autocomplete: vi.fn(),
    select: vi.fn(async (prompt: SelectPrompt<string>) => ({
      kind: "submitted" as const,
      value: prompt.options[0]?.value,
    })) as InteractivePrompter["select"],
    multiselect: vi.fn(async (prompt: MultiselectPrompt<string>) =>
      selection === "cancelled"
        ? { kind: "cancelled" as const }
        : {
            kind: "submitted" as const,
            value:
              typeof selection === "function"
                ? selection(prompt.options)
                : selection === "none"
                  ? []
                  : prompt.options.map((option) => option.value),
          },
    ) as InteractivePrompter["multiselect"],
    note: vi.fn(),
    confirm: vi.fn(async () =>
      confirmation === "cancelled"
        ? { kind: "cancelled" as const }
        : { kind: "submitted" as const, value: confirmation },
    ),
    spinner: vi.fn(),
    log: vi.fn(),
  };
}

function watchMutations(setup: ReturnType<typeof fixture>) {
  const fs = setup.dependencies.fileSystem;
  return [
    vi.spyOn(fs, "createExclusiveNoFollow"),
    vi.spyOn(fs, "mkdir"),
    vi.spyOn(fs, "rename"),
    vi.spyOn(fs, "unlink"),
  ];
}

function configurationBytes(setup: ReturnType<typeof fixture>) {
  return Object.values(setup.paths).map((path) => readFileSync(path, "utf8"));
}

function changeResource(
  setup: ReturnType<typeof fixture>,
  target: "codex" | "cursor",
) {
  const path = setup.paths[target];
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("/e/brain/mcp", "/e/changed/mcp"),
  );
}

describe("multiple managed installation removal", () => {
  it("removes a mounted HTTP engine from every selected client after one confirmation", async () => {
    const setup = fixture();
    await setup.install();
    const prompts = prompter();
    const mutations = watchMutations(setup);
    vi.mocked(prompts.confirm).mockImplementation(async () => {
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
      return { kind: "submitted", value: true };
    });

    expect(await setup.remove(prompts)).toBe(0);

    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(prompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: [] }),
    );
    expect(prompts.select).not.toHaveBeenCalled();
    expect(setup.state().installations).toEqual({});
    expect(readFileSync(setup.paths.codex, "utf8")).not.toContain("brain");
    expect(readFileSync(setup.paths.cursor, "utf8")).not.toContain("brain");
    expect(prompts.note).toHaveBeenCalledWith(
      "brain · Codex\nbrain · Cursor",
      "Selected installations",
    );
    expect(prompts.log).toHaveBeenCalledWith(
      "success",
      "brain · Codex: removed.",
    );
    expect(prompts.log).toHaveBeenCalledWith(
      "success",
      "brain · Cursor: removed.",
    );
    expect(setup.resolveExecutable).not.toHaveBeenCalled();
  });

  it("removes several engines in one client once in inventory order and preserves other installations", async () => {
    const setup = fixture();
    await setup.install();
    await setup.install(descriptor("catalog"));
    await setup.install(descriptor("other"));
    const cursorBefore = readFileSync(setup.paths.cursor, "utf8");
    const prompts = prompter((choices) => {
      const selected = choices
        .filter(({ label }) => /^(brain|catalog) · Codex$/.test(label))
        .map(({ value }) => value)
        .reverse();
      return [...selected, ...selected];
    });

    expect(await setup.remove(prompts)).toBe(0);

    expect(prompts.confirm).toHaveBeenCalledWith(
      "Remove 2 selected MCP installations?",
    );
    expect(prompts.note).toHaveBeenCalledWith(
      "brain · Codex\ncatalog · Codex",
      "Selected installations",
    );
    expect(vi.mocked(prompts.log).mock.calls).toEqual([
      ["success", "brain · Codex: removed."],
      ["success", "catalog · Codex: removed."],
    ]);
    expect(readFileSync(setup.paths.cursor, "utf8")).toBe(cursorBefore);
    const codex = readFileSync(setup.paths.codex, "utf8");
    expect(codex).not.toContain("brain");
    expect(codex).not.toContain("catalog");
    expect(codex).toContain("other");
    expect(
      Object.values(setup.state().installations).map(
        ({ entryId, targetId }) => [entryId, targetId],
      ),
    ).toEqual([
      ["remote-brain", "cursor"],
      ["remote-catalog", "cursor"],
      ["remote-other", "codex"],
      ["remote-other", "cursor"],
    ]);
  });

  it.each([
    ["none", true, 0],
    ["cancelled", true, 130],
    ["all", false, 0],
    ["all", "cancelled", 130],
  ] as const)(
    "makes no writes for selection %s and confirmation %s",
    async (selection, confirmation, expectedExit) => {
      const setup = fixture();
      await setup.install();
      const before = configurationBytes(setup);
      const mutations = watchMutations(setup);
      const prompts = prompter(selection, confirmation);

      expect(await setup.remove(prompts)).toBe(expectedExit);

      expect(configurationBytes(setup)).toEqual(before);
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
      if (selection !== "all") expect(prompts.confirm).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown choice alongside valid choices before confirmation or mutation", async () => {
    const setup = fixture();
    await setup.install();
    const before = configurationBytes(setup);
    const mutations = watchMutations(setup);
    const prompts = prompter((choices) => [
      ...choices.map(({ value }) => value),
      "unknown",
    ]);

    await expect(setup.remove(prompts)).rejects.toMatchObject({
      code: "INSTALLATION_UNAVAILABLE",
    });

    expect(prompts.confirm).not.toHaveBeenCalled();
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(configurationBytes(setup)).toEqual(before);
  });

  it("excludes drifted entries from selection and preserves their configuration and state", async () => {
    const setup = fixture();
    await setup.install();
    changeResource(setup, "cursor");
    const before = readFileSync(setup.paths.cursor, "utf8");
    const prompts = prompter();

    expect(await setup.remove(prompts)).toBe(0);

    expect(prompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [expect.objectContaining({ label: "brain · Codex" })],
      }),
    );
    expect(readFileSync(setup.paths.cursor, "utf8")).toBe(before);
    expect(Object.values(setup.state().installations)).toEqual([
      expect.objectContaining({ entryId: "remote-brain", targetId: "cursor" }),
    ]);
  });

  it.each(["codex", "cursor"] as const)(
    "revalidates %s after confirmation and preserves an independent success",
    async (changedTarget) => {
      const setup = fixture();
      await setup.install();
      const prompts = prompter();
      vi.mocked(prompts.confirm).mockImplementation(async () => {
        changeResource(setup, changedTarget);
        return { kind: "submitted", value: true };
      });

      expect(await setup.remove(prompts)).toBe(1);

      const unchangedTarget = changedTarget === "codex" ? "cursor" : "codex";
      expect(readFileSync(setup.paths[unchangedTarget], "utf8")).not.toContain(
        "brain",
      );
      expect(readFileSync(setup.paths[changedTarget], "utf8")).toContain(
        "/e/changed/mcp",
      );
      expect(Object.values(setup.state().installations)).toEqual([
        expect.objectContaining({
          entryId: "remote-brain",
          targetId: changedTarget,
        }),
      ]);
      expect(prompts.log).toHaveBeenCalledWith(
        "error",
        `brain · ${changedTarget === "codex" ? "Codex" : "Cursor"}: CONFIG_DRIFT: The managed MCP server was changed outside the installer.`,
      );
      expect(prompts.outro).toHaveBeenCalledWith(
        "Removal completed with errors.",
      );
    },
  );

  it("removes both native-disabled and detached-disabled installations without credential or runtime access", async () => {
    const setup = fixture();
    const protectedDescriptor = createRemoteInstallDescriptor({
      serverName: "brain",
      url: "http://127.0.0.1:3100/e/brain/mcp",
      bearerTokenEnvironment: "BRAIN_TOKEN",
    });
    await setup.install(protectedDescriptor);
    const disabled = await mutateDescriptorAcrossTargets({
      action: "disable",
      dependencies: setup.dependencies,
      descriptor: protectedDescriptor,
      snapshot: setup.snapshot,
      targetIds: ["codex", "cursor"],
    });
    expect(disabled.every(({ outcome }) => outcome === "disabled")).toBe(true);
    vi.spyOn(setup.dependencies.environment, "get").mockImplementation(
      (name) => {
        if (name === "BRAIN_TOKEN")
          throw new Error("Credential values must not be read.");
        return undefined;
      },
    );

    expect(await setup.remove(prompter())).toBe(0);

    expect(setup.state().installations).toEqual({});
    expect(setup.resolveExecutable).not.toHaveBeenCalled();
    expect(readFileSync(setup.paths.cursor, "utf8")).not.toContain("brain");
    expect(readFileSync(setup.paths.codex, "utf8")).not.toContain("brain");
  });

  it("uses each client's persisted descriptor when the same engine has different resource URLs", async () => {
    const setup = fixture();
    await setup.install(descriptor(), ["codex"]);
    const differentResource = createRemoteInstallDescriptor({
      serverName: "brain",
      url: "http://127.0.0.1:3100/e/other-revision/mcp",
    });
    await setup.install(differentResource, ["cursor"]);

    expect(await setup.remove(prompter())).toBe(0);

    expect(setup.state().installations).toEqual({});
    expect(readFileSync(setup.paths.codex, "utf8")).not.toContain("brain");
    expect(readFileSync(setup.paths.cursor, "utf8")).not.toContain("brain");
  });
});
