import { types as nodeUtilTypes } from "node:util";

import type { StandardSchemaV1 } from "@standard-schema/spec";

import { snapshotLosslessJson } from "./schema.js";

type ConnectorConfiguration = Readonly<Record<string, unknown>>;

export interface ConnectorConfigSchema<
  Input = unknown,
  Output extends ConnectorConfiguration = ConnectorConfiguration,
> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export type InferConnectorConfigInput<Schema extends ConnectorConfigSchema> =
  StandardSchemaV1.InferInput<Schema>;

export type InferConnectorConfigOutput<Schema extends ConnectorConfigSchema> =
  StandardSchemaV1.InferOutput<Schema>;

export type ConnectorPorts = Readonly<Record<string, unknown>>;

export interface ConnectorInstance<Ports extends ConnectorPorts> {
  readonly ports: Ports;
}

export interface ConnectorDefinition<
  Name extends string,
  ConfigSchema extends ConnectorConfigSchema,
  Dependencies,
  Ports extends ConnectorPorts,
> {
  readonly name: Name;
  readonly config: ConfigSchema;
  readonly create: (
    config: InferConnectorConfigOutput<ConfigSchema>,
    dependencies: Dependencies,
  ) => ConnectorInstance<Ports>;
}

export interface ConnectorFactory<
  Name extends string,
  ConfigSchema extends ConnectorConfigSchema,
  Dependencies,
  Ports extends ConnectorPorts,
> {
  readonly name: Name;
  readonly create: (
    config: InferConnectorConfigInput<ConfigSchema>,
    dependencies: Dependencies,
  ) => ConnectorInstance<Ports>;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDataProperty(value: object, key: PropertyKey): unknown {
  let current: object | null = value;
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      throw new TypeError("Connector contracts must not contain proxies.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new TypeError("Connector contracts must use data properties.");
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function invalidConfiguration(): TypeError {
  return new TypeError("Connector configuration is invalid.");
}

function validateConfiguration<ConfigSchema extends ConnectorConfigSchema>(
  standard: StandardSchemaV1.Props<unknown, unknown>,
  validate: StandardSchemaV1.Props<unknown, unknown>["validate"],
  value: InferConnectorConfigInput<ConfigSchema>,
): InferConnectorConfigOutput<ConfigSchema> {
  let result:
    | StandardSchemaV1.Result<unknown>
    | Promise<StandardSchemaV1.Result<unknown>>;
  try {
    result = Reflect.apply(validate, standard, [value]) as
      | StandardSchemaV1.Result<unknown>
      | Promise<StandardSchemaV1.Result<unknown>>;
  } catch {
    throw invalidConfiguration();
  }

  if (nodeUtilTypes.isPromise(result)) {
    void result.catch(() => undefined);
    throw new TypeError(
      "Connector configuration validation must be synchronous.",
    );
  }

  try {
    if (!isRecord(result) || nodeUtilTypes.isProxy(result)) {
      throw invalidConfiguration();
    }
    const issues = readDataProperty(result, "issues");
    if (issues !== undefined) throw invalidConfiguration();
    const validated = readDataProperty(result, "value");
    if (!isRecord(validated) || nodeUtilTypes.isProxy(validated)) {
      throw invalidConfiguration();
    }
    return snapshotLosslessJson(
      validated,
    ) as InferConnectorConfigOutput<ConfigSchema>;
  } catch {
    throw invalidConfiguration();
  }
}

function snapshotPorts<Ports extends ConnectorPorts>(
  instance: ConnectorInstance<Ports>,
): ConnectorInstance<Ports> {
  if (!isRecord(instance) || nodeUtilTypes.isProxy(instance)) {
    throw new TypeError(
      "Connector factory must return an object with a ports record.",
    );
  }

  let ports: unknown;
  try {
    ports = readDataProperty(instance, "ports");
  } catch {
    throw new TypeError(
      "Connector factory must return an object with a ports record.",
    );
  }
  if (!isRecord(ports) || nodeUtilTypes.isProxy(ports)) {
    throw new TypeError(
      "Connector factory must return an object with a ports record.",
    );
  }

  const names = Object.keys(ports);
  if (names.length === 0) {
    throw new TypeError("Connector factory must provide at least one port.");
  }
  const snapshot: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(ports, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Connector ports must use data properties.");
    }
    Object.defineProperty(snapshot, name, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  return Object.freeze({
    ports: Object.freeze(snapshot) as Ports,
  });
}

export function defineConnector<
  const Name extends string,
  const ConfigSchema extends ConnectorConfigSchema,
  Dependencies,
  const Ports extends ConnectorPorts,
>(
  definition: ConnectorDefinition<Name, ConfigSchema, Dependencies, Ports>,
): ConnectorFactory<Name, ConfigSchema, Dependencies, Ports> {
  if (!isRecord(definition) || nodeUtilTypes.isProxy(definition)) {
    throw new TypeError("A connector definition must be an object.");
  }

  const name = definition.name;
  const config = definition.config;
  const create = definition.create;
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Connector name must be a non-empty string.");
  }
  if (!isRecord(config) || nodeUtilTypes.isProxy(config)) {
    throw new TypeError("Connector configuration schema is malformed.");
  }

  let standard: unknown;
  let version: unknown;
  let vendor: unknown;
  let validate: unknown;
  try {
    standard = config["~standard"];
    if (!isRecord(standard) || nodeUtilTypes.isProxy(standard)) {
      throw new TypeError();
    }
    version = readDataProperty(standard, "version");
    vendor = readDataProperty(standard, "vendor");
    validate = readDataProperty(standard, "validate");
  } catch {
    throw new TypeError("Connector configuration schema is malformed.");
  }
  if (
    version !== 1 ||
    typeof vendor !== "string" ||
    typeof validate !== "function"
  ) {
    throw new TypeError("Connector configuration schema is malformed.");
  }
  if (typeof create !== "function") {
    throw new TypeError("Connector factory must be a function.");
  }

  const factory: ConnectorFactory<Name, ConfigSchema, Dependencies, Ports> = {
    name,
    create(
      rawConfig: InferConnectorConfigInput<ConfigSchema>,
      dependencies: Dependencies,
    ): ConnectorInstance<Ports> {
      const validated = validateConfiguration<ConfigSchema>(
        standard as StandardSchemaV1.Props<unknown, unknown>,
        validate as StandardSchemaV1.Props<unknown, unknown>["validate"],
        rawConfig,
      );
      return snapshotPorts<Ports>(
        Reflect.apply(create, undefined, [
          validated,
          dependencies,
        ]) as ConnectorInstance<Ports>,
      );
    },
  };
  return Object.freeze(factory);
}
