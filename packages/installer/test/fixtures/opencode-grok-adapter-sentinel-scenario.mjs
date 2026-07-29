import {
  configurationTargetAdapters,
  createTargetAdapterCounters,
} from "../../dist/target-adapters.js";

await import("./forbid-filesystem-writes.mjs");
await import("./forbid-filesystem-access.mjs");

const descriptor = Object.freeze({
  id: "support-engine",
  version: "1.0.0",
  title: "Support Engine",
  description: "Classify support tickets.",
  capabilityIds: Object.freeze(["support.classify-ticket"]),
  server: Object.freeze({
    name: "invokta-support",
    transport: Object.freeze({
      type: "streamable-http",
      url: "https://support.example.com/mcp",
      authentication: Object.freeze({
        type: "bearer-env",
        variable: "ADAPTER_SECRET_SENTINEL",
      }),
      headersFromEnv: Object.freeze({}),
    }),
  }),
});

const targets = ["opencode-v2", "grok-build"];
const results = [];
for (const targetId of targets) {
  const adapter = configurationTargetAdapters[targetId];
  if (adapter === undefined) throw new Error(`ADAPTER_MISSING:${targetId}`);
  const counters = createTargetAdapterCounters();
  const definition = adapter.descriptorToDefinition(descriptor);
  const installed = adapter.constructPatch({
    action: "install",
    definition,
    inspection: adapter.inspect({
      source: undefined,
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
  results.push({ targetId, definition, counters });
}

process.stdout.write(
  `${JSON.stringify({
    targets,
    oauth: results[0].definition.oauth,
    results,
  })}\n`,
);
