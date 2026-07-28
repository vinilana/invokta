import {
  configurationTargetAdapters,
  createTargetAdapterCounters,
} from "../../dist/target-adapters.js";

const adapter = configurationTargetAdapters.antigravity;
if (adapter === undefined) throw new Error("ANTIGRAVITY_ADAPTER_MISSING");

const descriptor = Object.freeze({
  id: "support-engine",
  version: "1.0.0",
  title: "Support Engine",
  description: "Classify support tickets.",
  capabilityIds: Object.freeze(["support.classify-ticket"]),
  server: Object.freeze({
    name: "ai-engine-support",
    transport: Object.freeze({
      type: "stdio",
      command: "support-engine-mcp",
      args: Object.freeze(["serve", "--stdio"]),
      forwardEnv: Object.freeze([]),
    }),
  }),
});
const httpDescriptor = Object.freeze({
  ...descriptor,
  server: Object.freeze({
    name: "ai-engine-support",
    transport: Object.freeze({
      type: "streamable-http",
      url: "https://support.example.com/mcp",
      authentication: Object.freeze({ type: "none" }),
      headersFromEnv: Object.freeze({}),
    }),
  }),
});
const unsupported = Object.freeze({
  ...descriptor,
  server: Object.freeze({
    ...descriptor.server,
    transport: Object.freeze({
      ...descriptor.server.transport,
      forwardEnv: Object.freeze(["ADAPTER_SECRET_SENTINEL"]),
    }),
  }),
});

const counters = createTargetAdapterCounters();
const definition = adapter.descriptorToDefinition(descriptor);
const installed = adapter.constructPatch({
  action: "install",
  definition,
  inspection: adapter.inspect({
    source: new TextEncoder().encode('{"mcpServers":{}}'),
    serverName: descriptor.server.name,
    counters,
  }),
  counters,
});
if (installed.kind !== "changed") throw new Error("INSTALL_DID_NOT_CHANGE");
const disabled = adapter.constructPatch({
  action: "disable",
  inspection: adapter.inspect({
    source: installed.postImage,
    serverName: descriptor.server.name,
  }),
});
if (disabled.kind !== "changed") throw new Error("DISABLE_DID_NOT_CHANGE");
const enabled = adapter.constructPatch({
  action: "enable",
  inspection: adapter.inspect({
    source: disabled.postImage,
    serverName: descriptor.server.name,
  }),
});
if (enabled.kind !== "changed") throw new Error("ENABLE_DID_NOT_CHANGE");

process.stdout.write(
  `${JSON.stringify({
    metadata: adapter.metadata,
    http: adapter.descriptorToDefinition(httpDescriptor),
    unsupported: adapter.compatibility(unsupported),
    counters,
  })}\n`,
);
