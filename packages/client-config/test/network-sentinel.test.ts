import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sentinel = fileURLToPath(
  new URL("./fixtures/forbid-network-access.mjs", import.meta.url),
);

const probes = [
  ["global fetch", 'fetch("https://example.invalid")'],
  ["global WebSocket", 'new WebSocket("wss://example.invalid")'],
  [
    "node:http",
    'const http = await import("node:http"); http.default.get("http://example.invalid")',
  ],
  [
    "node:https",
    'const https = await import("node:https"); https.default.get("https://example.invalid")',
  ],
  [
    "node:net",
    'const net = await import("node:net"); net.default.connect(80, "example.invalid")',
  ],
  [
    "node:tls",
    'const tls = await import("node:tls"); tls.default.connect(443, "example.invalid")',
  ],
  [
    "node:dns",
    'const dns = await import("node:dns"); dns.default.lookup("example.invalid", () => undefined)',
  ],
  [
    "node:dgram",
    'const dgram = await import("node:dgram"); dgram.default.createSocket("udp4")',
  ],
  [
    "node:http2",
    'const http2 = await import("node:http2"); http2.default.connect("https://example.invalid")',
  ],
] as const;

describe("installer runtime network sentinel", () => {
  it.each(probes)("blocks %s before a connection is opened", (_name, probe) => {
    const result = spawnSync(
      process.execPath,
      ["--import", sentinel, "--input-type=module", "--eval", probe],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INSTALLER_NETWORK_ACCESS_FORBIDDEN");
    expect(result.stderr).not.toContain("ENOTFOUND");
    expect(result.stderr).not.toContain("ECONN");
  });
});
