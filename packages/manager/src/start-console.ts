/**
 * Composition root for a console run.
 *
 * The URL, with its one-time session token, is printed before the browser is
 * launched, so the operator can always reach the console themselves.
 */

import { resolve } from "node:path";
import { createNodeFileSystem } from "@invokta/installer-core";

import { openBrowser } from "./browser.js";
import { createConsoleServer } from "./console-server.js";
import { createConsoleService } from "./console-service.js";
import type { ManagerExitCode, ManagerOptions } from "./run-manager-cli.js";
import { defaultScanRoots } from "./scan-roots.js";
import { createConsoleSession } from "./session.js";

export async function startConsole(
  options: ManagerOptions,
): Promise<ManagerExitCode> {
  const fileSystem = createNodeFileSystem();
  const scanRoots =
    options.scanRoots.length > 0
      ? options.scanRoots.map((root) => resolve(root))
      : await defaultScanRoots({
          fileSystem,
          workingDirectory: process.cwd(),
        });

  const service = await createConsoleService({ fileSystem, scanRoots });
  const session = createConsoleSession();
  const server = createConsoleServer({ service, session });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${String(port)}/?token=${session.token}`;

  const inventory = await service.read();
  process.stdout.write(
    [
      "",
      "Invokta manager",
      `  ${String(inventory.inventory.engines.length)} Action Engine${inventory.inventory.engines.length === 1 ? "" : "s"} across ${String(inventory.inventory.targets.length)} configuration target${inventory.inventory.targets.length === 1 ? "" : "s"}`,
      `  scanned ${String(inventory.discovery.inspectedDirectories)} directories in ${String(scanRoots.length)} root${scanRoots.length === 1 ? "" : "s"}`,
      "",
      `  ${url}`,
      "",
      "  This URL carries the session key for this process. Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  if (options.open) openBrowser(url);

  await new Promise<void>((resolveClose) => {
    const stop = () => {
      server.close(() => resolveClose());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
