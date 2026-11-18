import type {
  GatewayUpstream,
  GatewayUpstreamCapability,
  GatewayUpstreamKind,
} from "./types.js";

const registered = new WeakMap<
  GatewayUpstream,
  ReadonlyArray<GatewayUpstreamCapability>
>();

/** Freezes an upstream and records its capabilities for `createGateway`. */
export function registerUpstream(
  name: string,
  kind: GatewayUpstreamKind,
  capabilities: ReadonlyArray<GatewayUpstreamCapability>,
  extra: Readonly<Record<string, unknown>> = {},
): GatewayUpstream {
  const frozenCapabilities = Object.freeze([...capabilities]);
  const upstream = Object.freeze({
    name,
    kind,
    routes: Object.freeze(frozenCapabilities.map(({ route }) => route)),
    ...extra,
  });
  registered.set(upstream, frozenCapabilities);
  return upstream;
}

export function upstreamCapabilities(
  upstream: unknown,
): ReadonlyArray<GatewayUpstreamCapability> {
  const capabilities = registered.get(upstream as GatewayUpstream);
  if (capabilities === undefined) {
    throw new TypeError(
      "Gateway upstreams must be created by engineUpstream or mcpUpstream.",
    );
  }
  return capabilities;
}
