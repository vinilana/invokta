import {
  CapabilityError,
  type CapabilityErrorMap,
  type Engine,
  EngineError,
  type InvokeOptions,
  type Principal,
} from "@invokta/core";

import { isJsonObject, jsonSchemaContract } from "./json-schema-contract.js";
import { assertName, selectIncluded } from "./patterns.js";
import type {
  GatewayUpstream,
  GatewayUpstreamCapability,
  GatewayUpstreamRoute,
} from "./types.js";
import { registerUpstream } from "./upstream-registry.js";

export interface EngineUpstreamOptions {
  /** Unique upstream name used in routes, decisions, and diagnostics. */
  readonly name: string;
  /** An engine in this process. Its own access rules stay enforced. */
  readonly engine: Pick<Engine, "invoke" | "list" | "describe">;
  /** Optional prefix: the gateway publishes `<namespace>.<capability ID>`. */
  readonly namespace?: string;
  /** Upstream capability ID patterns to publish. Defaults to every capability. */
  readonly include?: ReadonlyArray<string>;
  /**
   * Maps the gateway caller to the principal the upstream engine receives.
   * Defaults to forwarding the gateway principal unchanged.
   */
  readonly principal?: (
    principal: Principal | null,
    route: GatewayUpstreamRoute,
  ) => Principal | null;
}

interface UpstreamInvoker {
  invoke(
    capabilityId: string,
    input: unknown,
    options: InvokeOptions,
  ): Promise<unknown>;
}

/**
 * Publishes the capabilities of an in-process engine through the gateway.
 *
 * The catalog is read once through `list` and `describe`. Each gateway
 * capability republishes the upstream contract and forwards to the upstream
 * `engine.invoke`, so upstream validation, access, timeout, and events still
 * apply behind the gateway's own policy.
 */
export function engineUpstream(
  options: EngineUpstreamOptions,
): GatewayUpstream {
  const name = assertName(options.name, "Upstream name");
  const namespace =
    options.namespace === undefined
      ? undefined
      : assertName(options.namespace, `Upstream ${name} namespace`);
  const mapPrincipal = options.principal ?? ((principal) => principal);
  if (typeof mapPrincipal !== "function") {
    throw new TypeError(`Upstream ${name} principal must be a function.`);
  }
  const engine = options.engine;
  const invoker = engine as unknown as UpstreamInvoker;
  const ids = selectIncluded(
    engine.list().map((summary) => summary.id),
    options.include,
    name,
  );

  const capabilities = ids.map((upstreamId): GatewayUpstreamCapability => {
    const described = engine.describe(upstreamId);
    const route: GatewayUpstreamRoute = Object.freeze({
      capabilityId:
        namespace === undefined ? upstreamId : `${namespace}.${upstreamId}`,
      upstream: name,
      kind: "engine",
      upstreamCapabilityId: upstreamId,
    });
    const errors = redeclareErrors(described.errors);
    return Object.freeze({
      route,
      ...(described.title === undefined ? {} : { title: described.title }),
      description: described.description,
      input: jsonSchemaContract(described.inputSchema),
      output: jsonSchemaContract(described.outputSchema),
      ...(described.annotations === undefined
        ? {}
        : { annotations: described.annotations }),
      ...(described.deprecated === undefined
        ? {}
        : { deprecated: described.deprecated }),
      ...(errors === undefined ? {} : { errors }),
      async run({ input, context }) {
        try {
          const output = await invoker.invoke(upstreamId, input, {
            requestId: context.requestId,
            source: context.source,
            principal: mapPrincipal(context.principal, route),
            signal: context.signal,
            onProgress: context.reportProgress,
          });
          if (!isJsonObject(output)) {
            throw new TypeError("The upstream engine returned a non-object.");
          }
          return output;
        } catch (error) {
          throw republish(error);
        }
      },
    } satisfies GatewayUpstreamCapability);
  });

  return registerUpstream(name, "engine", capabilities);
}

function redeclareErrors(
  described: ReadonlyArray<{
    readonly code: string;
    readonly description: string;
    readonly retryable: boolean;
    readonly detailsSchema?: Readonly<Record<string, unknown>>;
  }> = [],
): CapabilityErrorMap | undefined {
  if (described.length === 0) return undefined;
  const errors: Record<string, CapabilityErrorMap[string]> = {};
  for (const declared of described) {
    errors[declared.code] = {
      description: declared.description,
      retryable: declared.retryable,
      ...(declared.detailsSchema === undefined
        ? {}
        : { details: jsonSchemaContract(declared.detailsSchema) }),
    };
  }
  return Object.freeze(errors);
}

/**
 * The core never preserves a thrown `DOMAIN_ERROR`, so an upstream domain
 * error is raised again as the same declared `CapabilityError`. Every other
 * `EngineError` keeps its public code, and the core normalizes the rest.
 */
function republish(error: unknown): unknown {
  if (!(error instanceof EngineError) || error.code !== "DOMAIN_ERROR") {
    return error;
  }
  const details = error.publicDetails as
    | { readonly code?: unknown; readonly details?: unknown }
    | undefined;
  if (typeof details?.code !== "string") return error;
  return new CapabilityError(details.code, {
    ...(details.details === undefined ? {} : { details: details.details }),
    cause: error,
  });
}
