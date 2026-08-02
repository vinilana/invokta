import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configurationTargetAdapters,
  createNodeFileSystem,
  installDescriptorAcrossTargets,
} from "@invokta/installer-core";
import { runEngineRemovalSession } from "../../dist/engine-removal-session.js";

const homeDirectory = mkdtempSync(join(tmpdir(), "invokta-remove-sentinel-"));
let wallTime = Date.parse("2026-07-30T12:00:00.000Z");
let monotonic = 0;
let token = 0;
const environmentReads = new Set();
const descriptor = {
  id: "support-engine",
  version: "1.0.0",
  title: "Support Engine",
  description: "Support actions.",
  capabilityIds: ["tickets.summarize"],
  server: {
    name: "support-engine",
    transport: {
      type: "stdio",
      command: "/missing/node",
      args: ["/missing/project/dist/mcp-stdio.js"],
      forwardEnv: ["SUPPORT_API_TOKEN"],
    },
  },
};
const snapshot = {
  homeDirectory,
  surfaces: [],
  targets: [
    {
      id: "codex",
      displayName: "Codex",
      surfaceIds: [],
      evidence: "installed",
      executables: [],
      configuration: {
        kind: "absent",
        path: join(homeDirectory, ".codex/config.toml"),
      },
      eligible: true,
      mayCreateConfiguration: true,
      reloadHint: "Reload Codex.",
    },
  ],
};
const dependencies = {
  adapters: configurationTargetAdapters,
  currentUserId: process.getuid?.() ?? 0,
  environment: {
    get(name) {
      environmentReads.add(name);
      if (name === "SUPPORT_API_TOKEN") {
        throw new Error("LAUNCH_ENVIRONMENT_VALUE_READ");
      }
      return undefined;
    },
  },
  fileSystem: createNodeFileSystem(),
  lock: {
    clock: {
      monotonicNow: () => monotonic,
      now: () => wallTime,
      wait: async (milliseconds) => {
        monotonic += milliseconds;
        wallTime += milliseconds;
      },
    },
    processId: 451,
    randomBytes: (length) => {
      token += 1;
      return new Uint8Array(length).fill(token);
    },
  },
  now: () => new Date(wallTime).toISOString(),
};
const prompter = {
  intro() {},
  outro() {},
  cancel() {},
  async autocomplete() {
    throw new Error("unexpected prompt");
  },
  async select() {
    throw new Error("unexpected prompt");
  },
  async multiselect() {
    throw new Error("unexpected prompt");
  },
  note() {},
  async confirm() {
    return { kind: "submitted", value: true };
  },
  spinner() {
    throw new Error("unexpected spinner");
  },
  log() {},
};

try {
  await installDescriptorAcrossTargets({
    dependencies,
    descriptor,
    snapshot,
    targetIds: ["codex"],
  });
  const result = await runEngineRemovalSession({
    dependencies,
    prompter,
    snapshot: {
      ...snapshot,
      targets: [
        {
          ...snapshot.targets[0],
          evidence: "configuration-only",
          configuration: snapshot.targets[0].configuration,
          mayCreateConfiguration: false,
        },
      ],
    },
    source: {
      manifestPath: "/missing/project/invokta.mcp.json",
      id: "support-engine",
      title: "Support Engine",
      serverName: "support-engine",
    },
  });
  const state = JSON.parse(
    readFileSync(
      join(homeDirectory, ".local/state/invokta/installer.json"),
      "utf8",
    ),
  );
  process.stdout.write(
    `${JSON.stringify({
      result,
      environmentReads: [...environmentReads].sort(),
      installations: Object.keys(state.installations).length,
    })}\n`,
  );
} finally {
  rmSync(homeDirectory, { recursive: true, force: true });
}
