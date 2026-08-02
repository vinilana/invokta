import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeFileSystem } from "@invokta/client-config";

import { createConsoleService } from "../../dist/console-service.js";

const home = mkdtempSync(join(tmpdir(), "invokta-console-isolation-"));
const workspace = join(home, "workspace");
const cursorConfig = join(home, ".cursor", "mcp.json");
const environmentReads = new Set();

mkdirSync(join(home, ".cursor"), { recursive: true });
mkdirSync(join(home, ".state"), { recursive: true });
mkdirSync(join(workspace, "isolated", "dist"), { recursive: true });
writeFileSync(cursorConfig, '{\n  "mcpServers": {}\n}\n');
writeFileSync(
  join(workspace, "isolated", "invokta.mcp.json"),
  JSON.stringify({
    schemaVersion: 1,
    id: "isolated",
    version: "1.0.0",
    title: "Isolated Engine",
    description: "Isolation fixture.",
    capabilityIds: ["isolated.ping"],
    server: {
      name: "isolated",
      entrypoint: "dist/mcp-stdio.js",
      forwardEnv: [],
    },
  }),
);
writeFileSync(
  join(workspace, "isolated", "dist", "mcp-stdio.js"),
  "throw new Error('the console must never execute an engine');\n",
);

try {
  const service = await createConsoleService({
    scanRoots: [workspace],
    fileSystem: createNodeFileSystem(),
    environment: {
      get: (name) => {
        environmentReads.add(name);
        return name === "XDG_STATE_HOME" ? join(home, ".state") : undefined;
      },
    },
    resolveExecutable: async () => undefined,
    resolveHomeDirectory: () => home,
    platform: "linux",
  });

  const before = await service.read();
  const installed = await service.apply({
    action: "install",
    engineId: "isolated",
    targetIds: ["cursor"],
  });
  const after = await service.read({ refresh: true });
  const removed = await service.apply({
    action: "remove",
    engineId: "isolated",
    targetIds: ["cursor"],
  });

  process.stdout.write(
    `${JSON.stringify({
      discovered: before.inventory.engines.map(({ id }) => id),
      installed:
        installed.kind === "applied"
          ? installed.results[0].outcome
          : installed.kind,
      afterInstall:
        after.inventory.engines[0].cells.cursor.state === "managed"
          ? after.inventory.engines[0].cells.cursor.status
          : after.inventory.engines[0].cells.cursor.state,
      removed:
        removed.kind === "applied" ? removed.results[0].outcome : removed.kind,
      configuration: readFileSync(cursorConfig, "utf8"),
      environmentReads: [...environmentReads].sort(),
    })}\n`,
  );
} finally {
  rmSync(home, { force: true, recursive: true });
}
