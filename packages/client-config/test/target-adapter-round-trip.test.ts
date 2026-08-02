import { describe, expect, it } from "vitest";

import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
} from "../src/registry.js";
import { configurationTargetAdapters } from "../src/target-adapters.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function descriptor(): CapabilityInstallDescriptor {
  return {
    id: "probe",
    version: "1.0.0",
    title: "Probe",
    description: "Round-trip probe.",
    capabilityIds: ["probe.ping"],
    server: {
      name: "probe",
      transport: {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/workspace/probe/dist/mcp-stdio.js"],
        forwardEnv: [],
      },
    },
  };
}

/**
 * Installs and then removes the same definition, returning the bytes that
 * survive. Anything other than the original text means the adapter rewrote
 * part of a file it does not own.
 */
function roundTrip(targetId: ConfigurationTargetId, original: string): string {
  const adapter = configurationTargetAdapters[targetId];
  const install = adapter.constructPatch({
    action: "install",
    definition: adapter.descriptorToDefinition(descriptor()),
    inspection: adapter.inspect({
      source: encoder.encode(original),
      serverName: "probe",
    }),
  });
  if (install.kind !== "changed") throw new Error("Expected an install patch.");

  const remove = adapter.constructPatch({
    action: "remove",
    inspection: adapter.inspect({
      source: install.postImage,
      serverName: "probe",
    }),
  });
  if (remove.kind !== "changed") throw new Error("Expected a removal patch.");
  return decoder.decode(remove.postImage);
}

describe("configuration round trips leave the file as it was", () => {
  it.each([
    [
      "a single-line container",
      '{\n  "mcpServers": { "unrelated": { "command": "true" } }\n}\n',
    ],
    [
      "a single-line container without inner padding",
      '{\n  "mcpServers": {"unrelated": {"command": "true"}}\n}\n',
    ],
    [
      "an expanded container",
      '{\n  "mcpServers": {\n    "unrelated": { "command": "true" }\n  }\n}\n',
    ],
    ["an empty container", '{\n  "mcpServers": {}\n}\n'],
    [
      "a compact whole file",
      '{"mcpServers":{"unrelated":{"command":"true"}}}\n',
    ],
  ])("restores %s exactly", (_name, original) => {
    // The space before a closing brace used to be absorbed into the separator
    // on install and never given back on removal.
    expect(roundTrip("cursor", original)).toBe(original);
  });

  it.each([
    [
      "a single-line nested container",
      '{\n  "mcp": { "servers": { "unrelated": { "command": "true" } } }\n}\n',
    ],
    [
      "an expanded nested container",
      '{\n  "mcp": {\n    "servers": {\n      "unrelated": { "command": "true" }\n    }\n  }\n}\n',
    ],
    [
      // A trailing comma is JSON5 syntax, so only this family can carry it.
      "a nested container with a trailing comma",
      '{\n  "mcp": {\n    "servers": {\n      "unrelated": { "command": "true" },\n    }\n  }\n}\n',
    ],
  ])("restores %s exactly for a JSON5 client", (_name, original) => {
    expect(roundTrip("openclaw", original)).toBe(original);
  });
});
