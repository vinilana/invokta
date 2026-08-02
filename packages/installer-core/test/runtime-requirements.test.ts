import { describe, expect, it, vi } from "vitest";

import type { ExecutableEvidence } from "../src/harness-detection.js";
import type { SuspendedDescriptor } from "../src/installer-state.js";
import {
  type RuntimeRequirementsResult,
  resolveRuntimeRequirements,
} from "../src/runtime-requirements.js";

function executable(path: string, realPath = path): ExecutableEvidence {
  return Object.freeze({
    path,
    identity: Object.freeze({
      device: 7,
      inode: 11,
      realPath,
    }),
  });
}

function stdioDescriptor(
  command: string,
  forwardEnv: readonly string[] = [],
): SuspendedDescriptor {
  return Object.freeze({
    name: "invokta-support",
    transport: Object.freeze({
      type: "stdio",
      command,
      args: Object.freeze(["--transport", "stdio"]),
      forwardEnv: Object.freeze([...forwardEnv]),
    }),
  });
}

function httpDescriptor(): SuspendedDescriptor {
  return Object.freeze({
    name: "invokta-support",
    transport: Object.freeze({
      type: "streamable-http",
      url: "https://support.example/mcp",
      authentication: Object.freeze({
        type: "bearer-env",
        variable: "SUPPORT_BEARER_TOKEN",
      }),
      headersFromEnv: Object.freeze({
        "x-api-key": "SUPPORT_API_KEY",
        "x-shared-credential": "SUPPORT_BEARER_TOKEN",
      }),
    }),
  });
}

function serialized(result: RuntimeRequirementsResult): string {
  return JSON.stringify(result);
}

describe("runtime requirement evidence", () => {
  it.each([
    ["install", "support-engine-mcp", "/opt/support/bin/support-engine-mcp"],
    ["enable", "./bin/support-engine-mcp", "/workspace/bin/support-engine-mcp"],
  ] as const)(
    "resolves an %s stdio command exactly once and returns deeply immutable, secret-free evidence",
    async (action, command, resolvedCommand) => {
      const environmentSecret = "runtime-secret-stdio-65dd7a05";
      const resolveExecutable = vi.fn(async () => executable(resolvedCommand));
      const environmentGet = vi.fn(() => environmentSecret);

      const result = await resolveRuntimeRequirements({
        action,
        descriptor: stdioDescriptor(command, ["SUPPORT_API_TOKEN"]),
        resolveExecutable,
        environment: { get: environmentGet },
      });

      expect(resolveExecutable).toHaveBeenCalledTimes(1);
      expect(resolveExecutable).toHaveBeenCalledWith(command);
      expect(environmentGet).toHaveBeenCalledTimes(1);
      expect(environmentGet).toHaveBeenCalledWith("SUPPORT_API_TOKEN");
      expect(result).toEqual({
        kind: "ready",
        command: {
          declared: command,
          resolved: resolvedCommand,
        },
        requiredEnvironmentNames: ["SUPPORT_API_TOKEN"],
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.requiredEnvironmentNames)).toBe(true);
      expect(
        result.kind === "ready" &&
          result.command !== undefined &&
          Object.isFrozen(result.command),
      ).toBe(true);
      expect(serialized(result)).not.toContain(environmentSecret);
    },
  );

  it("reports the canonical executable real path instead of its lookup or symlink path", async () => {
    const result = await resolveRuntimeRequirements({
      action: "install",
      descriptor: stdioDescriptor("support-engine-mcp"),
      resolveExecutable: async () =>
        executable(
          "/usr/local/bin/support-engine-mcp",
          "/opt/support/bin/support-engine-mcp",
        ),
      environment: { get: () => undefined },
    });

    expect(result).toEqual({
      kind: "ready",
      command: {
        declared: "support-engine-mcp",
        resolved: "/opt/support/bin/support-engine-mcp",
      },
      requiredEnvironmentNames: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      result.kind === "ready" &&
        result.command !== undefined &&
        Object.isFrozen(result.command),
    ).toBe(true);
  });

  it("snapshots stateful executable paths once so later secret-bearing values cannot escape", async () => {
    const lookupSecret = "runtime-secret-second-lookup-2f5723ef";
    const realPathSecret = "runtime-secret-second-realpath-8161cf79";
    let lookupPathReads = 0;
    let identityReads = 0;
    let realPathReads = 0;
    const identity = Object.defineProperties(
      {},
      {
        device: { enumerable: true, value: 7 },
        inode: { enumerable: true, value: 11 },
        realPath: {
          enumerable: true,
          get() {
            realPathReads += 1;
            return realPathReads === 1
              ? "/opt/support/bin/support-engine-mcp"
              : `/tmp/${realPathSecret}`;
          },
        },
      },
    );
    const statefulEvidence = Object.defineProperties(
      {},
      {
        path: {
          enumerable: true,
          get() {
            lookupPathReads += 1;
            return lookupPathReads === 1
              ? "/usr/local/bin/support-engine-mcp"
              : `/tmp/${lookupSecret}`;
          },
        },
        identity: {
          enumerable: true,
          get() {
            identityReads += 1;
            return identity;
          },
        },
      },
    ) as ExecutableEvidence;

    const result = await resolveRuntimeRequirements({
      action: "enable",
      descriptor: stdioDescriptor("support-engine-mcp"),
      resolveExecutable: async () => statefulEvidence,
      environment: { get: () => undefined },
    });

    expect(result).toEqual({
      kind: "ready",
      command: {
        declared: "support-engine-mcp",
        resolved: "/opt/support/bin/support-engine-mcp",
      },
      requiredEnvironmentNames: [],
    });
    expect(lookupPathReads).toBe(1);
    expect(identityReads).toBe(1);
    expect(realPathReads).toBe(1);
    expect(serialized(result)).not.toContain(lookupSecret);
    expect(serialized(result)).not.toContain(realPathSecret);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("fails closed with COMMAND_NOT_FOUND for missing, relative, or hostile resolver evidence without inspecting environment values", async () => {
    const resolverSecret = "runtime-secret-resolver-ae3ac558";
    const environmentGet = vi.fn(() => "runtime-secret-unread-90c3b50e");
    const hostileEvidence = new Proxy(
      {},
      {
        get() {
          throw new Error(resolverSecret);
        },
      },
    ) as ExecutableEvidence;

    for (const resolveExecutable of [
      async () => undefined,
      async () => executable("relative/server"),
      async () => hostileEvidence,
      async () => {
        throw new Error(resolverSecret);
      },
    ]) {
      const result = await resolveRuntimeRequirements({
        action: "install",
        descriptor: stdioDescriptor("support-engine-mcp", [
          "SUPPORT_API_TOKEN",
        ]),
        resolveExecutable,
        environment: { get: environmentGet },
      });

      expect(result).toEqual({
        kind: "blocked",
        code: "COMMAND_NOT_FOUND",
        declaredCommand: "support-engine-mcp",
        requiredEnvironmentNames: ["SUPPORT_API_TOKEN"],
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.requiredEnvironmentNames)).toBe(true);
      expect(serialized(result)).not.toContain(resolverSecret);
    }
    expect(environmentGet).not.toHaveBeenCalled();
  });

  it("checks the HTTP bearer and header environment names once each without resolving or connecting to the URL", async () => {
    const bearerSecret = "runtime-secret-bearer-a0dd771e";
    const headerSecret = "runtime-secret-header-040b5962";
    const values: Readonly<Record<string, string>> = Object.freeze({
      SUPPORT_BEARER_TOKEN: bearerSecret,
      SUPPORT_API_KEY: headerSecret,
    });
    const environmentGet = vi.fn((name: string) => values[name]);
    const resolveExecutable = vi.fn(async () => {
      throw new Error("HTTP descriptors do not resolve commands");
    });

    const result = await resolveRuntimeRequirements({
      action: "install",
      descriptor: httpDescriptor(),
      resolveExecutable,
      environment: { get: environmentGet },
    });

    expect(result).toEqual({
      kind: "ready",
      requiredEnvironmentNames: ["SUPPORT_BEARER_TOKEN", "SUPPORT_API_KEY"],
    });
    expect(environmentGet.mock.calls).toEqual([
      ["SUPPORT_BEARER_TOKEN"],
      ["SUPPORT_API_KEY"],
    ]);
    expect(resolveExecutable).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.requiredEnvironmentNames)).toBe(true);
    expect(serialized(result)).not.toContain(bearerSecret);
    expect(serialized(result)).not.toContain(headerSecret);
    expect(serialized(result)).not.toContain("support.example");
  });

  it("returns every missing environment name and contains thrown or proxy-backed secret values", async () => {
    const thrownSecret = "runtime-secret-thrown-13d1f62a";
    const proxySecret = "runtime-secret-proxy-fdb509d4";
    const proxyValue = new Proxy(
      {},
      {
        get() {
          throw new Error(proxySecret);
        },
        getOwnPropertyDescriptor() {
          throw new Error(proxySecret);
        },
        ownKeys() {
          throw new Error(proxySecret);
        },
      },
    );
    const environment = {
      get(name: string): unknown {
        if (name === "THROWS") throw new Error(thrownSecret);
        if (name === "PROXY_VALUE") return proxyValue;
        if (name === "EMPTY") return "";
        return undefined;
      },
    };

    const result = await resolveRuntimeRequirements({
      action: "enable",
      descriptor: stdioDescriptor("support-engine-mcp", [
        "THROWS",
        "PROXY_VALUE",
        "EMPTY",
        "UNSET",
      ]),
      resolveExecutable: async () => executable("/opt/bin/support-engine-mcp"),
      environment,
    });

    expect(result).toEqual({
      kind: "blocked",
      code: "REQUIRED_ENV_MISSING",
      command: {
        declared: "support-engine-mcp",
        resolved: "/opt/bin/support-engine-mcp",
      },
      requiredEnvironmentNames: ["THROWS", "PROXY_VALUE", "EMPTY", "UNSET"],
      missingEnvironmentNames: ["THROWS", "PROXY_VALUE", "EMPTY", "UNSET"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.requiredEnvironmentNames)).toBe(true);
    expect(
      result.kind === "blocked" &&
        result.code === "REQUIRED_ENV_MISSING" &&
        Object.isFrozen(result.missingEnvironmentNames),
    ).toBe(true);
    expect(serialized(result)).not.toContain(thrownSecret);
    expect(serialized(result)).not.toContain(proxySecret);
  });

  it.each(["disable", "adopt"] as const)(
    "%s skips descriptor, resolver, and environment access",
    async (action) => {
      const skipSecret = "runtime-secret-skipped-a4a25fce";
      const descriptor = new Proxy(
        {},
        {
          get() {
            throw new Error(skipSecret);
          },
        },
      ) as SuspendedDescriptor;
      const environment = new Proxy(
        {},
        {
          get() {
            throw new Error(skipSecret);
          },
        },
      ) as { readonly get: (name: string) => unknown };
      const resolveExecutable = vi.fn(async () => {
        throw new Error(skipSecret);
      });

      const result = await resolveRuntimeRequirements({
        action,
        descriptor,
        resolveExecutable,
        environment,
      });

      expect(result).toEqual({
        kind: "ready",
        requiredEnvironmentNames: [],
      });
      expect(resolveExecutable).not.toHaveBeenCalled();
      expect(Object.isFrozen(result)).toBe(true);
      expect(serialized(result)).not.toContain(skipSecret);
    },
  );
});
