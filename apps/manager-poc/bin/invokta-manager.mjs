#!/usr/bin/env node

/**
 * `invokta-manager` proof of concept.
 *
 * Starts a loopback web console that shows every Action Engine this machine
 * knows about, which MCP clients each one is registered in, and where it could
 * be registered. Enable, disable, remove, and install are proposed from the
 * page and confirmed in this terminal.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import {
  defaultScanRoots,
  discoverEngineProjects,
} from "../src/engine-discovery.mjs";
import { createInstallerBridge } from "../src/installer-bridge.mjs";
import { createConsoleServer } from "../src/server.mjs";
import { createTerminalGate } from "../src/terminal-gate.mjs";

const usage = `Usage:
  invokta-manager [--port <number>] [--scan <directory>]... [--no-open]

Options:
  --port <number>     Listen on a fixed loopback port instead of an ephemeral one.
  --scan <directory>  Add a directory to the Action Engine project scan. Repeatable.
  --no-open           Print the console URL instead of opening a browser.
  --help              Show this message.
`;

function parseArguments(argv) {
  const options = { scanRoots: [], open: true, port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    if (flag === "--no-open") {
      options.open = false;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) return undefined;
    if (flag === "--port") {
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65_535)
        return undefined;
      options.port = port;
    } else if (flag === "--scan") {
      options.scanRoots.push(resolve(value));
    } else {
      return undefined;
    }
    index += 1;
  }
  return options;
}

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Printing the URL is always the reliable path.
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === undefined) {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  if (options.help === true) {
    process.stdout.write(usage);
    return;
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write(
      "NO_TTY: the console confirms every change in this terminal, so it needs an interactive session.\n",
    );
    process.exitCode = 2;
    return;
  }

  const scanRoots =
    options.scanRoots.length > 0
      ? options.scanRoots
      : await defaultScanRoots(process.cwd());

  const bridge = await createInstallerBridge();
  const gate = createTerminalGate({
    input: process.stdin,
    output: process.stdout,
    colors: process.stdout.isTTY === true,
  });
  const token = randomBytes(32).toString("base64url");
  const server = createConsoleServer({ bridge, gate, scanRoots, token });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${String(port)}/?token=${token}`;

  const discovery = await discoverEngineProjects(scanRoots);
  process.stdout.write(`\nInvokta manager (proof of concept)\n`);
  process.stdout.write(
    `  scanned ${String(discovery.inspected)} directories in ${String(scanRoots.length)} root${scanRoots.length === 1 ? "" : "s"}\n`,
  );
  process.stdout.write(
    `  found ${String(discovery.projects.length)} Action Engine project${discovery.projects.length === 1 ? "" : "s"}\n`,
  );
  process.stdout.write(`\n  ${url}\n\n`);
  process.stdout.write(
    "  Changes proposed in the browser are confirmed here. Press Ctrl+C to stop.\n",
  );
  if (options.open) openBrowser(url);

  process.on("SIGINT", () => {
    process.stdout.write("\nStopped.\n");
    server.close(() => process.exit(0));
  });
}

await main();
