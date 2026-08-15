import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { toMcpToolName } from "@invokta/mcp";

import { createAdapterRunner } from "./adapter-runner.js";
import type { ThrownValueInfo } from "./diagnostics.js";
import type { DoctorReport } from "./doctor.js";
import { doctorReportToJson, inspectEngine } from "./doctor.js";
import { startEngineHost } from "./engine-host.js";
import { createEntryTargetStore } from "./entry-target.js";
import { createHttpTargetStore } from "./http-target.js";
import { createPlaygroundOAuth } from "./playground-oauth.js";
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
  /** Oldest trace entries are dropped beyond this bound. Defaults to 500. */
  readonly traceCapacity?: number;
  /** Receives child and build diagnostics in watch mode. */
  readonly onDiagnostic?: (text: string) => void;
}

export interface ServeEngineOptions extends ServeCommonOptions {
  readonly engine: LoadedEngine;
  /**
   * The module the engine was loaded from. Adapter emulation spawns children
   * that import it themselves, so the path is required even though the parent
   * already holds the engine.
   */
  readonly module: {
    readonly specifier: string;
    readonly exportName: string;
  };
  /** Whether the module also exposes a tracked composed `capabilities` export. */
  readonly composedCapabilitiesExport: boolean;
}

export interface ServeWatchOptions extends ServeCommonOptions {
  readonly watch: {
    readonly moduleSpecifier: string;
    readonly exportName: string;
    readonly buildCommand: string;
    /** Watch roots relative to the cwd; defaults to the cwd itself. */
    readonly include?: string[];
    /** Extra ignored path segments or suffix globs (for example "*.log"). */
    readonly ignore?: string[];
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
  const trace = createTraceStore(
    options.traceCapacity === undefined
      ? {}
      : { capacity: options.traceCapacity },
  );
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

  // The in-process engine never changes, so the doctor report and the
  // capability descriptions are computed once instead of on every view
  // request. Watch mode rebuilds its own snapshot per child restart, so no
  // invalidation is needed here.
  let cachedView: EngineView | undefined;
  const engineView = (): EngineView => {
    if (cachedView !== undefined) return cachedView;
    let capabilities: EngineView["capabilities"] = [];
    try {
      capabilities = options.engine.list().map(({ id }) => ({
        ...options.engine.describe(id),
        mcpToolName: toMcpToolName(id),
      }));
    } catch {
      capabilities = [];
    }
    cachedView = {
      name: options.engine.name,
      version: options.engine.version,
      capabilities,
      doctor: doctorReportToJson(preflight),
    };
    return cachedView;
  };

  const httpTarget = createHttpTargetStore();
  const entryTarget = createEntryTargetStore();
  const oauth = createPlaygroundOAuth();
  const adapters = createAdapterRunner({
    module: options.module,
    cwd: options.cwd,
    mcpEndpoint: () =>
      `http://127.0.0.1:${String(engineHost.address().port)}/mcp`,
    httpTarget: () => httpTarget.resolve(),
    oauthCall: oauth.call,
    entryPoint: (adapter) => entryTarget.for(adapter),
  });

  let devtools: Awaited<ReturnType<typeof startDevtoolsServer>>;
  try {
    devtools = await startDevtoolsServer({
      engineView,
      principals,
      trace,
      adapters,
      httpTarget,
      entryTarget,
      oauth,
      cwd: options.cwd,
      module: options.module,
      enginePort: () => engineHost.address().port,
      port: devtoolsPort,
      ...(options.uiRoot === undefined ? {} : { uiRoot: options.uiRoot }),
    });
  } catch (error) {
    // Start-up failure releases the same resources shutdown does.
    await oauth.close().catch(() => undefined);
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
        await oauth.close();
        await engineHost.close();
      },
    },
  };
}

async function startWithWatch(
  options: ServeWatchOptions,
): Promise<StartServeResult> {
  const principals = createPrincipalStore();
  const trace = createTraceStore(
    options.traceCapacity === undefined
      ? {}
      : { capacity: options.traceCapacity },
  );
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
    ...(options.watch.include === undefined
      ? {}
      : { include: options.watch.include }),
    ...(options.watch.ignore === undefined
      ? {}
      : { ignore: options.watch.ignore }),
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

  const httpTarget = createHttpTargetStore();
  const entryTarget = createEntryTargetStore();
  const oauth = createPlaygroundOAuth();
  const adapters = createAdapterRunner({
    module: {
      specifier: options.watch.moduleSpecifier,
      exportName: options.watch.exportName,
    },
    cwd: options.cwd,
    mcpEndpoint: () =>
      `http://127.0.0.1:${String(watch.handles.enginePort())}/mcp`,
    httpTarget: () => httpTarget.resolve(),
    oauthCall: oauth.call,
    entryPoint: (adapter) => entryTarget.for(adapter),
  });

  let devtools: Awaited<ReturnType<typeof startDevtoolsServer>>;
  try {
    devtools = await startDevtoolsServer({
      engineView: watch.handles.engineView,
      principals,
      trace,
      adapters,
      httpTarget,
      entryTarget,
      oauth,
      cwd: options.cwd,
      module: {
        specifier: options.watch.moduleSpecifier,
        exportName: options.watch.exportName,
      },
      enginePort: watch.handles.enginePort,
      port: devtoolsPort,
      ...(options.uiRoot === undefined ? {} : { uiRoot: options.uiRoot }),
    });
  } catch (error) {
    // Start-up failure releases the same resources shutdown does.
    await oauth.close().catch(() => undefined);
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
        await oauth.close();
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
