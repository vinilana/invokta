import { execFileSync, spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

interface OpenedDevtools {
  readonly stdout: string;
  readonly stderr: string;
  readonly stop: () => Promise<number | null>;
}

async function openDevtools(
  args: readonly string[],
  port: number,
): Promise<OpenedDevtools> {
  const child = spawn(
    process.execPath,
    [join("packages/devtools/dist", "cli.js"), ...args, "--port", String(port)],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const stop = (): Promise<number | null> =>
    new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.kill("SIGTERM");
    });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`open never became ready: ${stderr}`)),
        8000,
      );
      const poll = setInterval(() => {
        if (stdout.includes("\n")) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    stop,
  };
}

/**
 * The origin the ready line reports. The requested port can be taken between
 * the probe and the spawn, and walking to the next one is the behavior under
 * test elsewhere; here only the path has to match.
 */
function readyBase(stdout: string, path: string): string {
  const suffix = path === "/" ? "/" : path;
  const match = new RegExp(
    `^Invokta devtools listening on (http://localhost:\\d+)${suffix}\n$`,
    "u",
  ).exec(stdout);
  if (match?.[1] === undefined) {
    throw new Error(`Unexpected ready line: ${JSON.stringify(stdout)}`);
  }
  return match[1];
}

describe("invokta-devtools open", () => {
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-b",
        "packages/devtools",
        "--pretty",
        "false",
      ],
      { cwd: repositoryRoot, stdio: "pipe" },
    );
  });

  it("lands on the chooser and serves both workbenches", async () => {
    const port = await freePort();
    const devtools = await openDevtools([], port);
    // A parallel test can claim the port between the probe and the spawn, and
    // the walk is the point: the ready line names the port that answered.
    const base = readyBase(devtools.stdout, "/");

    try {
      expect(devtools.stdout).toBe(`Invokta devtools listening on ${base}/\n`);
      expect(devtools.stderr).toContain("workbenches: MCP and CLI");

      const chooser = await fetch(`${base}/`);
      expect(chooser.status).toBe(200);
      expect(await chooser.text()).toContain("/assets/chooser-app.js");

      for (const path of ["/mcp", "/cli"]) {
        const workbench = await fetch(`${base}${path}`);
        expect(workbench.status, path).toBe(200);
        expect(await workbench.text()).toContain("Invokta DevTools");
      }
    } finally {
      expect(await devtools.stop()).toBe(0);
    }
  }, 20_000);

  it("lands on the workbench --mcp and --cli select", async () => {
    for (const [flag, path] of [
      ["--mcp", "/mcp"],
      ["--cli", "/cli"],
    ] as const) {
      const port = await freePort();
      const devtools = await openDevtools([flag], port);
      try {
        const base = readyBase(devtools.stdout, path);
        expect(devtools.stdout, flag).toBe(
          `Invokta devtools listening on ${base}${path}\n`,
        );
        // The peer workbench stays mounted, so the switch has somewhere to go.
        const peer = await fetch(`${base}${path === "/mcp" ? "/cli" : "/mcp"}`);
        expect(peer.status).toBe(200);
        await peer.arrayBuffer();
      } finally {
        expect(await devtools.stop(), flag).toBe(0);
      }
    }
  }, 30_000);
});
