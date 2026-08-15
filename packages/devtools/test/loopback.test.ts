import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  devtoolsHost,
  devtoolsOrigin,
  listenOnLoopback,
  literalLoopbackOrigin,
  loopbackAuthorities,
  loopbackOrigins,
} from "../src/loopback.js";

const started: Server[] = [];

function trackedServer(): Server {
  const server = createServer((_request, response) => {
    response.end();
  });
  started.push(server);
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(started.splice(0).map(closeServer));
});

describe("loopback authorities", () => {
  it("advertises localhost and accepts every loopback authority", () => {
    expect(devtoolsHost).toBe("localhost");
    expect(devtoolsOrigin(4100)).toBe("http://localhost:4100");
    expect(literalLoopbackOrigin(4100)).toBe("http://127.0.0.1:4100");
    expect([...loopbackAuthorities(4100)]).toStrictEqual([
      "localhost:4100",
      "127.0.0.1:4100",
      "[::1]:4100",
    ]);
    expect(loopbackOrigins(4100)).toStrictEqual([
      "http://localhost:4100",
      "http://127.0.0.1:4100",
      "http://[::1]:4100",
    ]);
  });
});

describe("listenOnLoopback", () => {
  it("binds the requested port and reports no port change", async () => {
    const probe = trackedServer();
    const probePort = await listenOnLoopback(probe, { port: 0 });
    await closeServer(probe);

    const inUse: number[] = [];
    const server = trackedServer();
    const port = await listenOnLoopback(server, {
      port: probePort,
      onPortInUse: (busy) => {
        inUse.push(busy);
      },
    });

    expect(port).toBe(probePort);
    expect((server.address() as AddressInfo).port).toBe(probePort);
    expect(inUse).toStrictEqual([]);
  });

  it("selects the next free port when the requested one is taken", async () => {
    const holder = trackedServer();
    const taken = await listenOnLoopback(holder, { port: 0 });

    const inUse: number[] = [];
    const server = trackedServer();
    const port = await listenOnLoopback(server, {
      port: taken,
      onPortInUse: (busy) => {
        inUse.push(busy);
      },
    });

    expect(port).toBeGreaterThan(taken);
    expect(inUse[0]).toBe(taken);
  });

  it("walks past a run of taken ports", async () => {
    // Another parallel test can claim the neighbouring port first, so the
    // pair of consecutive ports is retried until both binds land.
    let taken = 0;
    for (let attempt = 0; ; attempt += 1) {
      const first = trackedServer();
      taken = await listenOnLoopback(first, { port: 0 });
      const second = trackedServer();
      try {
        await listenOnLoopback(second, { port: taken + 1, maxPortAttempts: 1 });
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await closeServer(first);
      }
    }

    const inUse: number[] = [];
    const server = trackedServer();
    const port = await listenOnLoopback(server, {
      port: taken,
      onPortInUse: (busy) => {
        inUse.push(busy);
      },
    });

    expect(port).toBe(taken + 2);
    expect(inUse).toStrictEqual([taken, taken + 1]);
  });

  it("never walks away from an ephemeral port request", async () => {
    const server = trackedServer();
    const port = await listenOnLoopback(server, { port: 0 });
    expect(port).toBeGreaterThan(0);
  });

  it("reports the address in use when every attempt is taken", async () => {
    const holder = trackedServer();
    const taken = await listenOnLoopback(holder, { port: 0 });

    const server = trackedServer();
    await expect(
      listenOnLoopback(server, { port: taken, maxPortAttempts: 1 }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("refuses a port outside the range instead of throwing nothing", async () => {
    const server = trackedServer();
    await expect(
      listenOnLoopback(server, { port: 70_000 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(server.listening).toBe(false);
  });

  it("binds the literal loopback address so localhost reaches it", async () => {
    const server = trackedServer();
    const port = await listenOnLoopback(server, { port: 0 });
    const response = await fetch(`http://localhost:${String(port)}/`);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });
});
