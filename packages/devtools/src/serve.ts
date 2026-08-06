import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { startEngineHost } from "./engine-host.js";
import type { LoadedEngine } from "./load-engine.js";
import { createPrincipalStore } from "./principal-store.js";
import type { DevtoolsServerAddress } from "./server.js";
import { startDevtoolsServer } from "./server.js";
import type { DoctorReport } from "./doctor.js";
import { inspectEngine } from "./doctor.js";
import { createTraceStore } from "./trace-store.js";

export interface StartServeOptions {
  readonly engine: LoadedEngine;
  readonly cwd: string;
  /** Whether the module also exposes a tracked composed `capabilities` export. */
  readonly composedCapabilitiesExport: boolean;
  /** Defaults to 4100. */
  readonly port?: number;
  /** Defaults to an ephemeral loopback port. */
  readonly enginePort?: number;
  /** Directory holding the built interface bundle; defaults to the shipped one. */
  readonly uiRoot?: string;
}

export interface ServeHandles {
  readonly devtoolsAddress: DevtoolsServerAddress;
  readonly engineAddress: DevtoolsServerAddress;
  readonly doctorReport: DoctorReport;
  close(): Promise<void>;
}

export type StartServeResult =
  | { readonly kind: "started"; readonly handles: ServeHandles }
  | { readonly kind: "refused"; readonly report: DoctorReport };

const mcpManifestFileName = "invokta.mcp.json";

/**
 * Starts the two-server development surface: the engine host (the unmodified
 * MCP HTTP adapter around the observing delegate) and the single-origin
 * devtools interface server that proxies `/mcp` to it. The engine is
 * preflighted with the doctor checks and refused on any finding.
 */
export async function startServe(
  options: StartServeOptions,
): Promise<StartServeResult> {
  const doctor = (): DoctorReport =>
    inspectEngine(options.engine, {
      mcpManifestPresent: existsSync(resolve(options.cwd, mcpManifestFileName)),
      composedCapabilitiesExport: options.composedCapabilitiesExport,
    });

  const preflight = doctor();
  if (preflight.findings.length > 0) {
    return { kind: "refused", report: preflight };
  }

  const principals = createPrincipalStore();
  const trace = createTraceStore();

  const devtoolsPort = options.port ?? 4100;
  const allowedOrigin = `http://127.0.0.1:${String(devtoolsPort)}`;

  const engineHost = await startEngineHost({
    engine: options.engine,
    ...(options.enginePort === undefined ? {} : { port: options.enginePort }),
    allowedOrigin,
    authenticate: principals.authenticate,
    onRecord: (record) => {
      trace.appendInvocation(record);
    },
  });

  let devtools: Awaited<ReturnType<typeof startDevtoolsServer>>;
  try {
    devtools = await startDevtoolsServer({
      engine: options.engine,
      principals,
      trace,
      doctor,
      enginePort: engineHost.address().port,
      port: devtoolsPort,
      ...(options.uiRoot === undefined ? {} : { uiRoot: options.uiRoot }),
    });
  } catch (error) {
    await engineHost.close();
    throw error;
  }

  return {
    kind: "started",
    handles: {
      devtoolsAddress: devtools.address(),
      engineAddress: engineHost.address(),
      doctorReport: preflight,
      close: async () => {
        await devtools.close();
        await engineHost.close();
      },
    },
  };
}
