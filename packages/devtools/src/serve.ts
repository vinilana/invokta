import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ThrownValueInfo } from "./diagnostics.js";
import type { DoctorReport } from "./doctor.js";
import { doctorReportToJson, inspectEngine } from "./doctor.js";
import { startEngineHost } from "./engine-host.js";
import type { LoadedEngine } from "./load-engine.js";
import { createPrincipalStore } from "./principal-store.js";
import type { DevtoolsServerAddress, EngineView } from "./server.js";
import { startDevtoolsServer } from "./server.js";
import { createTraceStore } from "./trace-store.js";
import { startWatchMode } from "./watch.js";

interface ServeCommonOptions {
  readonly cwd: string;
  /** Defaults to 4100. */
  readonly port?: number;
  /** Defaults to an ephemeral loopback port. */
  readonly enginePort?: number;
  /** Directory holding the built interface bundle; defaults to the shipped one. */
  readonly uiRoot?: string;
  /** Receives child and build diagnostics in watch mode. */
  readonly onDiagnostic?: (text: string) => void;
}

export interface ServeEngineOptions extends ServeCommonOptions {
  readonly engine: LoadedEngine;
  /** Whether the module also exposes a tracked composed `capabilities` export. */
  readonly composedCapabilitiesExport: boolean;
}

export interface ServeWatchOptions extends ServeCommonOptions {
  readonly watch: {
    readonly moduleSpecifier: string;
    readonly exportName: string;
    readonly buildCommand: string;
  };
}

export type StartServeOptions = ServeEngineOptions | ServeWatchOptions;

export interface ServeHandles {
  readonly devtoolsAddress: DevtoolsServerAddress;
  readonly engineAddress: DevtoolsServerAddress;
  close(): Promise<void>;
}

export type StartServeResult =
  | { readonly kind: "started"; readonly handles: ServeHandles }
  | { readonly kind: "refused"; readonly report: DoctorReport }
  | {
      readonly kind: "load-error";
      readonly stage: "load-failed" | "export-missing" | "not-an-engine";
      readonly error?: ThrownValueInfo;
    };

const mcpManifestFileName = "invokta.mcp.json";

async function startWithEngine(
  options: ServeEngineOptions,
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
    allowedOrigins: [allowedOrigin],
    authenticate: principals.authenticate,
    onRecord: (record) => {
      trace.appendInvocation(record);
    },
  });

  const engineView = (): EngineView => {
    let capabilities: EngineView["capabilities"] = [];
    try {
      capabilities = options.engine
        .list()
        .map(({ id }) => options.engine.describe(id));
    } catch {
      capabilities = [];
    }
    return {
      name: options.engine.name,
      version: options.engine.version,
      capabilities,
      doctor: doctorReportToJson(doctor()),
    };
  };

  let devtools: Awaited<ReturnType<typeof startDevtoolsServer>>;
  try {
    devtools = await startDevtoolsServer({
      engineView,
      principals,
      trace,
      enginePort: () => engineHost.address().port,
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
      close: async () => {
        await devtools.close();
        await engineHost.close();
      },
    },
  };
}

async function startWithWatch(
  options: ServeWatchOptions,
): Promise<StartServeResult> {
  const principals = createPrincipalStore();
  const trace = createTraceStore();
  const devtoolsPort = options.port ?? 4100;
  const allowedOrigin = `http://127.0.0.1:${String(devtoolsPort)}`;

  const watch = await startWatchMode({
    moduleSpecifier: options.watch.moduleSpecifier,
    exportName: options.watch.exportName,
    cwd: options.cwd,
    buildCommand: options.watch.buildCommand,
    allowedOrigin,
    ...(options.enginePort === undefined
      ? {}
      : { enginePort: options.enginePort }),
    principals,
    trace,
    ...(options.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: options.onDiagnostic }),
  });
  if (watch.kind === "load-error") {
    return watch;
  }
  if (watch.kind === "refused") {
    // The child reports the JSON-safe body, which is shape-compatible with
    // the report: thrown values are already reduced to name/code/message.
    return { kind: "refused", report: watch.doctor as DoctorReport };
  }

  let devtools: Awaited<ReturnType<typeof startDevtoolsServer>>;
  try {
    devtools = await startDevtoolsServer({
      engineView: watch.handles.engineView,
      principals,
      trace,
      enginePort: watch.handles.enginePort,
      port: devtoolsPort,
      ...(options.uiRoot === undefined ? {} : { uiRoot: options.uiRoot }),
    });
  } catch (error) {
    await watch.handles.close();
    throw error;
  }

  return {
    kind: "started",
    handles: {
      devtoolsAddress: devtools.address(),
      engineAddress: { host: "127.0.0.1", port: watch.handles.enginePort() },
      close: async () => {
        await devtools.close();
        await watch.handles.close();
      },
    },
  };
}

/**
 * Starts the two-server development surface: the engine host (the unmodified
 * MCP HTTP adapter around the observing delegate) and the single-origin
 * devtools interface server that proxies `/mcp` to it. The engine is
 * preflighted with the doctor checks and refused on any finding. In watch
 * mode the engine host runs in a replaceable child process instead.
 */
export async function startServe(
  options: StartServeOptions,
): Promise<StartServeResult> {
  if ("watch" in options) {
    return startWithWatch(options);
  }
  return startWithEngine(options);
}
