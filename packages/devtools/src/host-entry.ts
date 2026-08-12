#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type { Principal } from "@invokta/core";
import { toMcpToolName } from "@invokta/mcp";

import { readThrownValueInfo } from "./diagnostics.js";
import { doctorReportToJson, inspectEngine } from "./doctor.js";
import { startEngineHost } from "./engine-host.js";
import {
  hasComposedCapabilitiesExport,
  loadEngineModule,
} from "./load-engine.js";

/**
 * The watch-mode engine host child. It loads the built module once, hosts it
 * over the MCP HTTP adapter, and speaks a line protocol with the devtools
 * parent: protocol messages go to stderr as single JSON lines prefixed with
 * `@invokta-devtools `, and the parent mirrors the principal token table in
 * through stdin. Applying a rebuild means replacing this whole process —
 * the child never reloads a module.
 */

const protocolPrefix = "@invokta-devtools ";

function emit(message: unknown): void {
  process.stderr.write(`${protocolPrefix}${JSON.stringify(message)}\n`);
}

interface MirroredPrincipal {
  readonly token: string;
  readonly principal: Principal;
}

async function main(): Promise<number> {
  const [moduleSpecifier, exportName, allowedOrigin, portArgument] =
    process.argv.slice(2);
  if (
    moduleSpecifier === undefined ||
    exportName === undefined ||
    allowedOrigin === undefined
  ) {
    emit({ type: "fatal", reason: "invalid-arguments" });
    return 2;
  }

  const loaded = await loadEngineModule({
    moduleSpecifier,
    exportName,
    cwd: process.cwd(),
  });
  if (loaded.kind !== "loaded") {
    emit({
      type: "load-error",
      stage: loaded.kind,
      ...(loaded.kind === "load-failed"
        ? { error: readThrownValueInfo(loaded.error) }
        : {}),
    });
    return 2;
  }

  const report = inspectEngine(loaded.engine, {
    mcpManifestPresent: existsSync(resolve(process.cwd(), "invokta.mcp.json")),
    composedCapabilitiesExport: hasComposedCapabilitiesExport(loaded.namespace),
  });
  if (report.findings.length > 0) {
    emit({ type: "doctor-findings", doctor: doctorReportToJson(report) });
    return 1;
  }

  let tokens: readonly MirroredPrincipal[] = [];
  const stdinLines = createInterface({ input: process.stdin });
  stdinLines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as {
        readonly type?: unknown;
        readonly records?: unknown;
      };
      if (message.type === "principals" && Array.isArray(message.records)) {
        tokens = message.records as readonly MirroredPrincipal[];
      }
    } catch {
      // A malformed control line is ignored; the previous table stays active.
    }
  });

  const host = await startEngineHost({
    engine: loaded.engine,
    ...(portArgument === undefined || portArgument === "0"
      ? {}
      : { port: Number(portArgument) }),
    allowedOrigins: [allowedOrigin],
    authenticate: (request) => {
      const header = request.headers.get("authorization");
      if (header === null) return null;
      const match = /^[ \t]*bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
      const presented = match?.[1];
      if (presented === undefined) return null;
      return (
        tokens.find((entry) => entry.token === presented)?.principal ?? null
      );
    },
    onRecord: (record) => {
      emit({ type: "record", record });
    },
  });

  let describedCapabilities: unknown = [];
  try {
    describedCapabilities = loaded.engine.list().map(({ id }) => ({
      ...loaded.engine.describe(id),
      mcpToolName: toMcpToolName(id),
    }));
  } catch {
    describedCapabilities = [];
  }
  emit({
    type: "ready",
    port: host.address().port,
    engine: { name: loaded.engine.name, version: loaded.engine.version },
    capabilities: describedCapabilities,
    doctor: doctorReportToJson(report),
  });

  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdin.once("end", stop);
  });
  await host.close();
  return 0;
}

process.exitCode = await main();
