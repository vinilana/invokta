import { describe, expect, it } from "vitest";

import { InstallerError } from "../src/installer-error.js";
import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
} from "../src/registry.js";
import { configurationTargetAdapters } from "../src/target-adapters.js";

const secretSentinel = "INVERSE_SECRET_SENTINEL_0c76e8";

function stdioDescriptor(
  targetId: ConfigurationTargetId,
): CapabilityInstallDescriptor {
  const supportsEnvironment =
    targetId !== "antigravity" && targetId !== "kimi-code";
  return {
    id: "support-engine",
    version: "1.0.0",
    title: "Support Engine",
    description: "Support tools.",
    capabilityIds: ["support.classify"],
    server: {
      name: "invokta-support",
      transport: {
        type: "stdio",
        command: "support-engine-mcp",
        args: ["serve", "--stdio"],
        forwardEnv: supportsEnvironment
          ? ["SUPPORT_API_TOKEN", "SUPPORT_TENANT"]
          : [],
      },
    },
  };
}

function httpDescriptor(
  targetId: ConfigurationTargetId,
): CapabilityInstallDescriptor {
  const authentication =
    targetId === "antigravity"
      ? ({ type: "none" } as const)
      : ({ type: "bearer-env", variable: "SUPPORT_API_TOKEN" } as const);
  const supportsHeaders =
    targetId !== "antigravity" && targetId !== "kimi-code";
  return {
    ...stdioDescriptor(targetId),
    server: {
      name: "invokta-support",
      transport: {
        type: "streamable-http",
        url: "https://support.example.com/mcp",
        authentication,
        headersFromEnv: supportsHeaders
          ? { "x-support-tenant": "SUPPORT_TENANT" }
          : {},
      },
    },
  };
}

function expectInstallerCode(
  action: () => unknown,
  code: InstallerError["code"],
) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InstallerError);
    expect((error as InstallerError).code).toBe(code);
    expect((error as InstallerError).message).not.toContain(secretSentinel);
    expect(String((error as InstallerError).cause)).not.toContain(
      secretSentinel,
    );
    return;
  }
  throw new Error(`Expected ${code}.`);
}

describe("target descriptor inverse mappings", () => {
  it.each(Object.keys(configurationTargetAdapters) as ConfigurationTargetId[])(
    "round-trips installed stdio and HTTP definitions for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      for (const descriptor of [
        stdioDescriptor(targetId),
        httpDescriptor(targetId),
      ]) {
        const installedDefinition = adapter.descriptorToDefinition(descriptor);
        const suspended = adapter.definitionToSuspendedDescriptor(
          descriptor.server.name,
          installedDefinition,
        );

        expect(suspended).toEqual(descriptor.server);
        expect(Object.isFrozen(suspended)).toBe(true);
        expect(Object.isFrozen(suspended.transport)).toBe(true);
        expect(adapter.suspendedDescriptorToDefinition(suspended)).toEqual(
          installedDefinition,
        );
      }
    },
  );

  it.each(Object.keys(configurationTargetAdapters) as ConfigurationTargetId[])(
    "rejects non-placeholder values without retaining a secret for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const definition = adapter.descriptorToDefinition(
        stdioDescriptor(targetId),
      );
      const forged = {
        ...definition,
        secret: secretSentinel,
      };

      expectInstallerCode(
        () =>
          adapter.definitionToSuspendedDescriptor("invokta-support", forged),
        "HARNESS_CONFIG_INVALID",
      );
    },
  );

  it.each([
    "codex",
    "hermes",
    "openclaw",
    "claude-code",
    "cursor",
    "opencode-v2",
    "grok-build",
  ] as const)(
    "rejects a literal environment value in the %s inverse mapping",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const definition = adapter.descriptorToDefinition(
        stdioDescriptor(targetId),
      );
      const environmentField =
        targetId === "codex"
          ? "env_vars"
          : targetId === "opencode-v2"
            ? "environment"
            : "env";
      const forged = {
        ...definition,
        [environmentField]:
          targetId === "codex"
            ? [secretSentinel]
            : { SUPPORT_API_TOKEN: secretSentinel },
      };

      expectInstallerCode(
        () =>
          adapter.definitionToSuspendedDescriptor("invokta-support", forged),
        "HARNESS_CONFIG_INVALID",
      );
    },
  );

  it("rejects a non-enumerable field that an inverse could otherwise lose", () => {
    const adapter = configurationTargetAdapters.cursor;
    const definition = {
      ...adapter.descriptorToDefinition(stdioDescriptor("cursor")),
    };
    Object.defineProperty(definition, "secret", {
      enumerable: false,
      value: secretSentinel,
    });

    expectInstallerCode(
      () =>
        adapter.definitionToSuspendedDescriptor("invokta-support", definition),
      "HARNESS_CONFIG_INVALID",
    );
  });

  it.each(Object.keys(configurationTargetAdapters) as ConfigurationTargetId[])(
    "rejects every noncanonical or credential-bearing HTTP URL for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      const definition = adapter.descriptorToDefinition(
        httpDescriptor(targetId),
      );
      const urlField = targetId === "antigravity" ? "serverUrl" : "url";
      const adversarialUrls = [
        `https://user:${secretSentinel}@example.com/mcp`,
        "https://example.com/not-mcp",
        "https://example.com/mcp?credential=hidden",
        "https://example.com/mcp#fragment",
        "http://example.com/mcp",
        "http://localhost/mcp",
        "ftp://example.com/mcp",
        "/mcp",
        "https://example.com/%6dcp",
      ];

      for (const url of adversarialUrls) {
        expectInstallerCode(
          () =>
            adapter.definitionToSuspendedDescriptor("invokta-support", {
              ...definition,
              [urlField]: url,
            }),
          "HARNESS_CONFIG_INVALID",
        );
      }
    },
  );

  it.each(Object.keys(configurationTargetAdapters) as ConfigurationTargetId[])(
    "accepts only the specified insecure loopback HTTP exception for %s",
    (targetId) => {
      const adapter = configurationTargetAdapters[targetId];
      for (const url of ["http://127.0.0.1/mcp", "http://[::1]/mcp"]) {
        const source = httpDescriptor(targetId);
        if (source.server.transport.type !== "streamable-http") {
          throw new Error("Expected HTTP descriptor.");
        }
        const descriptor = {
          ...source,
          server: {
            ...source.server,
            transport: { ...source.server.transport, url },
          },
        };
        const definition = adapter.descriptorToDefinition(descriptor);

        expect(
          adapter.definitionToSuspendedDescriptor(
            descriptor.server.name,
            definition,
          ).transport,
        ).toMatchObject({ type: "streamable-http", url });
      }
    },
  );
});
