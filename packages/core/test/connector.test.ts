import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type ConnectorConfigSchema,
  createEngine,
  defineCapability,
  defineConnector,
} from "../src/index.js";

function connectorConfigSchema<Input, Output>(
  validate: (
    value: unknown,
  ) =>
    | { readonly value: Output }
    | { readonly issues: ReadonlyArray<{ readonly message: string }> }
    | Promise<
        | { readonly value: Output }
        | { readonly issues: ReadonlyArray<{ readonly message: string }> }
      >,
): ConnectorConfigSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "connector-contract-test",
      validate,
    },
  };
}

describe("connector authoring", () => {
  it("defines an inert connector that validates configuration before creating named ports", () => {
    const validate = vi.fn((value: unknown) => {
      const input = value as { readonly endpoint: string };
      return {
        value: {
          endpoint: input.endpoint.trim(),
          limits: { maximumRequests: 3 },
        },
      };
    });
    const schema = connectorConfigSchema<
      { readonly endpoint: string },
      {
        readonly endpoint: string;
        readonly limits: { readonly maximumRequests: number };
      }
    >(validate);
    const dependencies = { fetch: vi.fn<typeof globalThis.fetch>() };
    const reader = { read: vi.fn(async () => "value") };
    let observedConfig:
      | {
          readonly endpoint: string;
          readonly limits: { readonly maximumRequests: number };
        }
      | undefined;
    let observedDependencies: typeof dependencies | undefined;
    const create = vi.fn(
      (
        config: {
          readonly endpoint: string;
          readonly limits: { readonly maximumRequests: number };
        },
        receivedDependencies: typeof dependencies,
      ) => {
        observedConfig = config;
        observedDependencies = receivedDependencies;
        return { ports: { reader } };
      },
    );
    const definition = {
      name: "example-reader",
      config: schema,
      create,
    };

    const connector = defineConnector(definition);

    expect(validate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(connector.name).toBe("example-reader");

    Object.assign(definition, {
      name: "changed",
      create: () => ({ ports: { changed: {} } }),
    });
    Object.assign(schema["~standard"], {
      validate: () => ({
        value: { endpoint: "changed", limits: { maximumRequests: 1 } },
      }),
    });

    const instance = connector.create(
      { endpoint: " https://provider.example " },
      dependencies,
    );

    expect(validate).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(observedConfig).toEqual({
      endpoint: "https://provider.example",
      limits: { maximumRequests: 3 },
    });
    expect(Object.isFrozen(observedConfig)).toBe(true);
    expect(Object.isFrozen(observedConfig?.limits)).toBe(true);
    expect(observedDependencies).toBe(dependencies);
    expect(instance).toEqual({ ports: { reader } });
    expect(instance.ports.reader).toBe(reader);
    expect(Object.isFrozen(instance)).toBe(true);
    expect(Object.isFrozen(instance.ports)).toBe(true);
    expect(Object.isFrozen(reader)).toBe(false);
  });

  it("sanitizes configuration validation failures and does not call the factory", () => {
    const secret = "connector-secret-canary";
    const create = vi.fn(() => ({ ports: { reader: {} } }));
    const connector = defineConnector({
      name: "invalid-config",
      config: connectorConfigSchema(() => ({
        issues: [{ message: `Invalid credential ${secret}.` }],
      })),
      create,
    });

    let failure: unknown;
    try {
      connector.create({}, {});
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe(
      "Connector configuration is invalid.",
    );
    expect(String(failure)).not.toContain(secret);
    expect((failure as Error & { readonly cause?: unknown }).cause).toBe(
      undefined,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("sanitizes thrown configuration validators", () => {
    const secret = "thrown-secret-canary";
    const connector = defineConnector({
      name: "throwing-config",
      config: connectorConfigSchema(() => {
        throw new Error(`Do not retain ${secret}.`);
      }),
      create: () => ({ ports: { reader: {} } }),
    });

    expect(() => connector.create({}, {})).toThrow(
      "Connector configuration is invalid.",
    );
    try {
      connector.create({}, {});
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect((error as Error & { readonly cause?: unknown }).cause).toBe(
        undefined,
      );
    }
  });

  it("rejects asynchronous configuration validation before connector creation", () => {
    const create = vi.fn(() => ({ ports: { reader: {} } }));
    const connector = defineConnector({
      name: "async-config",
      config: connectorConfigSchema(async () => ({ value: {} })),
      create,
    });

    expect(() => connector.create({}, {})).toThrow(
      "Connector configuration validation must be synchronous.",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("requires validated configuration to be a lossless JSON object", () => {
    for (const value of [
      null,
      [],
      { invalid: undefined },
      { invalid: Number.NaN },
      { invalid: () => undefined },
    ]) {
      const connector = defineConnector({
        name: "unsafe-config",
        config: connectorConfigSchema(() => ({ value })),
        create: () => ({ ports: { reader: {} } }),
      });

      expect(() => connector.create({}, {})).toThrow(
        "Connector configuration is invalid.",
      );
    }
  });

  it("validates connector definitions and factory results", () => {
    const config = z.object({});
    const create = () => ({ ports: { reader: {} } });

    expect(() => defineConnector({ name: "", config, create })).toThrow(
      "Connector name must be a non-empty string.",
    );
    expect(() =>
      defineConnector({
        name: "missing-schema",
        config: {} as typeof config,
        create,
      }),
    ).toThrow("Connector configuration schema is malformed.");
    expect(() =>
      defineConnector({
        name: "missing-factory",
        config,
        create: undefined as unknown as typeof create,
      }),
    ).toThrow("Connector factory must be a function.");

    const missingPorts = defineConnector({
      name: "missing-ports",
      config,
      create: () => ({}) as { readonly ports: { readonly reader: object } },
    });
    expect(() => missingPorts.create({}, {})).toThrow(
      "Connector factory must return an object with a ports record.",
    );

    const emptyPorts = defineConnector({
      name: "empty-ports",
      config,
      create: () => ({ ports: {} }),
    });
    expect(() => emptyPorts.create({}, {})).toThrow(
      "Connector factory must provide at least one port.",
    );
  });

  it("preserves connector-specific construction failures after configuration validation", () => {
    const failure = new Error("The provider client could not be constructed.");
    const connector = defineConnector({
      name: "failing-factory",
      config: z.object({}),
      create: () => {
        throw failure;
      },
    });

    expect(() => connector.create({}, {})).toThrow(failure);
  });

  it("injects only connector ports into capabilities without publishing connector metadata", async () => {
    const connector = defineConnector({
      name: "private-provider",
      config: z.object({ prefix: z.string() }),
      create: (config) => ({
        ports: {
          reader: {
            async read(value: string): Promise<string> {
              return `${config.prefix}:${value}`;
            },
          },
        },
      }),
    });
    const { reader } = connector.create({ prefix: "domain" }, {}).ports;
    const engine = createEngine({
      name: "connector-engine",
      version: "1.0.0",
      capabilities: {
        "domain.read": defineCapability({
          description: "Read a value through an injected domain port.",
          input: z.object({ value: z.string() }),
          output: z.object({ result: z.string() }),
          access: "public",
          timeoutMs: 1_000,
          async run({ input }) {
            return { result: await reader.read(input.value) };
          },
        }),
      },
    });

    await expect(
      engine.invoke("domain.read", { value: "item" }),
    ).resolves.toEqual({ result: "domain:item" });
    expect(engine.list()).toEqual([
      {
        id: "domain.read",
        description: "Read a value through an injected domain port.",
      },
    ]);
    expect(JSON.stringify(engine.list())).not.toContain("private-provider");
  });
});
