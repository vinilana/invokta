import { describe, expect, it, vi } from "vitest";

import {
  configurationTargetCatalog,
  harnessSurfaceCatalog,
} from "../src/harness-catalog.js";
import type {
  ExecutableEvidence,
  TargetConfigEvidenceProbes,
} from "../src/harness-detection.js";
import { detectHarnesses } from "../src/harness-detection.js";
import { configurationTargetIds } from "../src/registry.js";

const expectedSurfaces = [
  {
    id: "antigravity-cli",
    displayName: "Antigravity CLI (AGY)",
    executableCandidates: ["agy"],
    targetId: "antigravity",
  },
  {
    id: "antigravity-ide",
    displayName: "Antigravity IDE",
    executableCandidates: ["antigravity"],
    targetId: "antigravity",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    executableCandidates: ["claude"],
    targetId: "claude-code",
  },
  {
    id: "claude-desktop",
    displayName: "Claude Desktop",
    executableCandidates: ["Claude"],
    targetId: "claude-desktop",
  },
  {
    id: "codex",
    displayName: "Codex",
    executableCandidates: ["codex"],
    targetId: "codex",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    executableCandidates: ["cursor", "cursor-agent"],
    targetId: "cursor",
  },
  {
    id: "grok-build",
    displayName: "Grok Build",
    executableCandidates: ["grok"],
    targetId: "grok-build",
  },
  {
    id: "hermes",
    displayName: "Hermes Agent",
    executableCandidates: ["hermes"],
    targetId: "hermes",
  },
  {
    id: "kimi-code",
    displayName: "Kimi Code CLI",
    executableCandidates: ["kimi"],
    targetId: "kimi-code",
  },
  {
    id: "openclaw",
    displayName: "OpenClaw",
    executableCandidates: ["openclaw"],
    targetId: "openclaw",
  },
  {
    id: "opencode-v2",
    displayName: "OpenCode v2",
    executableCandidates: ["opencode2"],
    targetId: "opencode-v2",
  },
  {
    id: "vscode",
    displayName: "Visual Studio Code",
    executableCandidates: ["code"],
    targetId: "vscode",
  },
] as const;

function absentConfigProbes(
  onProbe: (targetId: string, homeDirectory: string) => void = () => undefined,
): TargetConfigEvidenceProbes {
  return Object.fromEntries(
    configurationTargetIds.map((targetId) => [
      targetId,
      async ({ homeDirectory }: { readonly homeDirectory: string }) => {
        onProbe(targetId, homeDirectory);
        return {
          kind: "absent",
          path: `${homeDirectory}/fixture-config/${targetId}`,
        } as const;
      },
    ]),
  ) as unknown as TargetConfigEvidenceProbes;
}

function executable(
  candidate: string,
  identity = candidate,
): ExecutableEvidence {
  return {
    path: `/fixture/bin/${candidate}`,
    identity: {
      device: 7,
      inode: [...identity].reduce((total, character) => {
        return total * 37 + (character.codePointAt(0) as number);
      }, 17),
      realPath: `/fixture/real/${identity}`,
    },
  };
}

describe("first-release harness catalog", () => {
  it("defines the exact twelve surfaces in deterministic surface-ID order", () => {
    expect(harnessSurfaceCatalog).toEqual(expectedSurfaces);
    expect(harnessSurfaceCatalog).toHaveLength(12);
    expect(harnessSurfaceCatalog.map(({ id }) => id)).toEqual(
      [...harnessSurfaceCatalog.map(({ id }) => id)].sort(),
    );
  });

  it("defines exactly one catalog record and reload hint for all eleven targets", () => {
    expect(configurationTargetCatalog.map(({ id }) => id)).toEqual(
      configurationTargetIds,
    );
    expect(configurationTargetCatalog).toHaveLength(11);
    expect(
      configurationTargetCatalog.every(
        ({ displayName, reloadHint }) =>
          displayName.length > 0 && reloadHint.length > 0,
      ),
    ).toBe(true);
  });
});

describe("harness detection snapshot", () => {
  it("reports all twelve executable surfaces without executing them and coalesces them into eleven targets", async () => {
    const candidateCalls: string[] = [];
    const probeCalls: Array<{ targetId: string; homeDirectory: string }> = [];

    const snapshot = await detectHarnesses({
      resolveHomeDirectory: vi.fn(() => "/users/tester"),
      resolveExecutable: vi.fn(async (candidate) => {
        candidateCalls.push(candidate);
        return executable(candidate);
      }),
      configEvidenceProbes: absentConfigProbes((targetId, homeDirectory) =>
        probeCalls.push({ targetId, homeDirectory }),
      ),
    });

    expect(snapshot.surfaces).toHaveLength(12);
    expect(snapshot.surfaces.map(({ id, evidence }) => [id, evidence])).toEqual(
      expectedSurfaces.map(({ id }) => [id, "installed"]),
    );
    expect(candidateCalls).toEqual(
      expectedSurfaces.flatMap(
        ({ executableCandidates }) => executableCandidates,
      ),
    );
    expect(probeCalls).toEqual(
      configurationTargetIds.map((targetId) => ({
        targetId,
        homeDirectory: "/users/tester",
      })),
    );
    expect(snapshot.targets).toHaveLength(11);
    expect(snapshot.targets.map(({ id }) => id)).toEqual(
      configurationTargetIds,
    );
    expect(
      snapshot.targets.every(({ evidence }) => evidence === "installed"),
    ).toBe(true);
    expect(snapshot.targets.every(({ eligible }) => eligible)).toBe(true);
    expect(
      snapshot.targets.every(
        ({ mayCreateConfiguration }) => mayCreateConfiguration,
      ),
    ).toBe(true);
    expect(
      snapshot.targets.map(({ id, configuration }) => ({ id, configuration })),
    ).toEqual(
      configurationTargetIds.map((targetId) => ({
        id: targetId,
        configuration: {
          kind: "absent",
          path: `/users/tester/fixture-config/${targetId}`,
        },
      })),
    );

    const antigravity = snapshot.targets.find(({ id }) => id === "antigravity");
    expect(antigravity).toMatchObject({
      displayName: "Antigravity (AGY CLI + IDE)",
      surfaceIds: ["antigravity-cli", "antigravity-ide"],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.targets)).toBe(true);
  });

  it("suppresses the Antigravity IDE surface when its launcher is the AGY legacy alias", async () => {
    const sharedIdentity = executable("agy", "same-antigravity-file");

    const snapshot = await detectHarnesses({
      resolveHomeDirectory: () => "/users/tester",
      resolveExecutable: async (candidate) => {
        if (candidate === "agy") return sharedIdentity;
        if (candidate === "antigravity") {
          return {
            path: "/fixture/bin/antigravity",
            identity: sharedIdentity.identity,
          };
        }
        return undefined;
      },
      configEvidenceProbes: absentConfigProbes(),
    });

    expect(
      snapshot.surfaces.find(({ id }) => id === "antigravity-cli"),
    ).toMatchObject({ evidence: "installed" });
    expect(
      snapshot.surfaces.find(({ id }) => id === "antigravity-ide"),
    ).toMatchObject({ evidence: "absent", executables: [] });
    expect(
      snapshot.targets.find(({ id }) => id === "antigravity"),
    ).toMatchObject({
      displayName: "Antigravity CLI (AGY)",
      surfaceIds: ["antigravity-cli"],
      evidence: "installed",
    });
  });

  it("classifies an explicitly identified Antigravity legacy launcher as AGY CLI evidence", async () => {
    const snapshot = await detectHarnesses({
      resolveHomeDirectory: () => "/users/tester",
      resolveExecutable: async (candidate) =>
        candidate === "antigravity"
          ? {
              ...executable("antigravity", "legacy-wrapper"),
              legacyAliasFor: "agy",
            }
          : undefined,
      configEvidenceProbes: absentConfigProbes(),
    });

    expect(
      snapshot.surfaces.find(({ id }) => id === "antigravity-cli"),
    ).toMatchObject({
      evidence: "installed",
      executables: [
        {
          candidate: "antigravity",
          legacyAliasFor: "agy",
        },
      ],
    });
    expect(
      snapshot.surfaces.find(({ id }) => id === "antigravity-ide"),
    ).toMatchObject({ evidence: "absent", executables: [] });
  });

  it("deduplicates multiple executable candidates for one surface by stable identity", async () => {
    const sharedIdentity = executable("cursor", "same-cursor-file");

    const snapshot = await detectHarnesses({
      resolveHomeDirectory: () => "/users/tester",
      resolveExecutable: async (candidate) => {
        if (candidate !== "cursor" && candidate !== "cursor-agent") {
          return undefined;
        }
        return {
          path: `/fixture/bin/${candidate}`,
          identity: sharedIdentity.identity,
        };
      },
      configEvidenceProbes: absentConfigProbes(),
    });

    expect(snapshot.surfaces.find(({ id }) => id === "cursor")).toMatchObject({
      evidence: "installed",
      executables: [{ candidate: "cursor", path: "/fixture/bin/cursor" }],
    });
  });

  it.each(configurationTargetIds)(
    "labels an existing %s config without an executable as configuration-only and forbids creation",
    async (configurationOnlyTarget) => {
      const snapshot = await detectHarnesses({
        resolveHomeDirectory: () => "/users/tester",
        resolveExecutable: async () => undefined,
        configEvidenceProbes: Object.fromEntries(
          configurationTargetIds.map((targetId) => [
            targetId,
            async () =>
              targetId === configurationOnlyTarget
                ? ({
                    kind: "present",
                    path: `/users/tester/config/${targetId}`,
                  } as const)
                : ({
                    kind: "absent",
                    path: `/users/tester/config/${targetId}`,
                  } as const),
          ]),
        ) as unknown as TargetConfigEvidenceProbes,
      });

      const target = snapshot.targets.find(
        ({ id }) => id === configurationOnlyTarget,
      );
      expect(target).toMatchObject({
        evidence: "configuration-only",
        eligible: true,
        mayCreateConfiguration: false,
        configuration: {
          kind: "present",
          path: `/users/tester/config/${configurationOnlyTarget}`,
        },
      });
      expect(
        snapshot.targets
          .filter(({ id }) => id !== configurationOnlyTarget)
          .every(
            ({ evidence, eligible, mayCreateConfiguration }) =>
              evidence === "absent" && !eligible && !mayCreateConfiguration,
          ),
      ).toBe(true);
    },
  );

  it("fails a target closed when its config evidence is unsafe even if its executable exists", async () => {
    const snapshot = await detectHarnesses({
      resolveHomeDirectory: () => "/users/tester",
      resolveExecutable: async (candidate) =>
        candidate === "codex" ? executable(candidate) : undefined,
      configEvidenceProbes: Object.fromEntries(
        configurationTargetIds.map((targetId) => [
          targetId,
          async () =>
            targetId === "codex"
              ? ({
                  kind: "blocked",
                  code: "HARNESS_CONFIG_UNSAFE",
                } as const)
              : ({
                  kind: "absent",
                  path: `/users/tester/config/${targetId}`,
                } as const),
        ]),
      ) as unknown as TargetConfigEvidenceProbes,
    });

    expect(snapshot.targets.find(({ id }) => id === "codex")).toMatchObject({
      evidence: "blocked",
      eligible: false,
      mayCreateConfiguration: false,
      configuration: {
        kind: "blocked",
        code: "HARNESS_CONFIG_UNSAFE",
      },
    });
  });

  it("rechecks vanished executable and configuration facts through the same probes", async () => {
    let executablePresent = true;
    let configurationPresent = true;
    const configPath = "/users/tester/.codex/config.toml";
    const resolveExecutable = vi.fn(async (candidate: string) =>
      executablePresent && candidate === "codex"
        ? executable(candidate)
        : undefined,
    );
    const codexProbe = vi.fn(async () =>
      configurationPresent
        ? ({ kind: "present", path: configPath } as const)
        : ({ kind: "absent", path: configPath } as const),
    );
    const configEvidenceProbes = {
      ...absentConfigProbes(),
      codex: codexProbe,
    };
    const options = {
      resolveHomeDirectory: () => "/users/tester",
      resolveExecutable,
      configEvidenceProbes,
    };

    const initial = await detectHarnesses(options);
    expect(initial.targets.find(({ id }) => id === "codex")).toMatchObject({
      evidence: "installed",
      configuration: { kind: "present", path: configPath },
      mayCreateConfiguration: true,
    });

    executablePresent = false;
    configurationPresent = false;

    const rechecked = await detectHarnesses(options);
    expect(rechecked.targets.find(({ id }) => id === "codex")).toMatchObject({
      evidence: "absent",
      configuration: { kind: "absent", path: configPath },
      eligible: false,
      mayCreateConfiguration: false,
    });
    expect(codexProbe).toHaveBeenCalledTimes(2);
    expect(resolveExecutable).toHaveBeenCalledTimes(
      expectedSurfaces.flatMap(
        ({ executableCandidates }) => executableCandidates,
      ).length * 2,
    );
  });
});
