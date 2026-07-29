import type { ConfigurationTargetId } from "./registry.js";

export interface HarnessSurfaceDefinition {
  readonly id:
    | "antigravity-cli"
    | "antigravity-ide"
    | "claude-code"
    | "claude-desktop"
    | "codex"
    | "cursor"
    | "grok-build"
    | "hermes"
    | "kimi-code"
    | "openclaw"
    | "opencode-v2"
    | "vscode";
  readonly displayName: string;
  readonly executableCandidates: readonly string[];
  readonly targetId: ConfigurationTargetId;
}

export interface ConfigurationTargetDefinition {
  readonly id: ConfigurationTargetId;
  readonly displayName: string;
  readonly reloadHint: string;
}

function surface(
  definition: HarnessSurfaceDefinition,
): HarnessSurfaceDefinition {
  return Object.freeze({
    ...definition,
    executableCandidates: Object.freeze([...definition.executableCandidates]),
  });
}

function target(
  definition: ConfigurationTargetDefinition,
): ConfigurationTargetDefinition {
  return Object.freeze({ ...definition });
}

export const harnessSurfaceCatalog = Object.freeze([
  surface({
    id: "antigravity-cli",
    displayName: "Antigravity CLI (AGY)",
    executableCandidates: ["agy"],
    targetId: "antigravity",
  }),
  surface({
    id: "antigravity-ide",
    displayName: "Antigravity IDE",
    executableCandidates: ["antigravity"],
    targetId: "antigravity",
  }),
  surface({
    id: "claude-code",
    displayName: "Claude Code",
    executableCandidates: ["claude"],
    targetId: "claude-code",
  }),
  surface({
    id: "claude-desktop",
    displayName: "Claude Desktop",
    executableCandidates: ["Claude"],
    targetId: "claude-desktop",
  }),
  surface({
    id: "codex",
    displayName: "Codex",
    executableCandidates: ["codex"],
    targetId: "codex",
  }),
  surface({
    id: "cursor",
    displayName: "Cursor",
    executableCandidates: ["cursor", "cursor-agent"],
    targetId: "cursor",
  }),
  surface({
    id: "grok-build",
    displayName: "Grok Build",
    executableCandidates: ["grok"],
    targetId: "grok-build",
  }),
  surface({
    id: "hermes",
    displayName: "Hermes Agent",
    executableCandidates: ["hermes"],
    targetId: "hermes",
  }),
  surface({
    id: "kimi-code",
    displayName: "Kimi Code CLI",
    executableCandidates: ["kimi"],
    targetId: "kimi-code",
  }),
  surface({
    id: "openclaw",
    displayName: "OpenClaw",
    executableCandidates: ["openclaw"],
    targetId: "openclaw",
  }),
  surface({
    id: "opencode-v2",
    displayName: "OpenCode v2",
    executableCandidates: ["opencode2"],
    targetId: "opencode-v2",
  }),
  surface({
    id: "vscode",
    displayName: "Visual Studio Code",
    executableCandidates: ["code"],
    targetId: "vscode",
  }),
] as const satisfies readonly HarnessSurfaceDefinition[]);

export type HarnessSurfaceId = (typeof harnessSurfaceCatalog)[number]["id"];

export const configurationTargetCatalog = Object.freeze([
  target({
    id: "antigravity",
    displayName: "Antigravity",
    reloadHint:
      "In AGY use /mcp to reload; in the IDE refresh MCP servers or restart it.",
  }),
  target({
    id: "claude-code",
    displayName: "Claude Code",
    reloadHint: "Start a new Claude Code session and inspect with /mcp.",
  }),
  target({
    id: "claude-desktop",
    displayName: "Claude Desktop",
    reloadHint: "Restart Claude Desktop, then inspect its MCP integrations.",
  }),
  target({
    id: "codex",
    displayName: "Codex",
    reloadHint: "Start a new Codex session or restart the active client.",
  }),
  target({
    id: "cursor",
    displayName: "Cursor",
    reloadHint: "Start a new Cursor Agent session or restart Cursor.",
  }),
  target({
    id: "grok-build",
    displayName: "Grok Build",
    reloadHint: "In /mcps, press r to refresh, or start a new session.",
  }),
  target({
    id: "hermes",
    displayName: "Hermes Agent",
    reloadHint: "Run /reload-mcp or start a new Hermes session.",
  }),
  target({
    id: "kimi-code",
    displayName: "Kimi Code CLI",
    reloadHint: "Start a new Kimi session and inspect with /mcp.",
  }),
  target({
    id: "openclaw",
    displayName: "OpenClaw",
    reloadHint:
      "Let an active config watcher hot-apply the change; otherwise restart the Gateway, then inspect with openclaw mcp status.",
  }),
  target({
    id: "opencode-v2",
    displayName: "OpenCode v2",
    reloadHint: "Start a new OpenCode v2 session.",
  }),
  target({
    id: "vscode",
    displayName: "Visual Studio Code",
    reloadHint: "Run MCP: List Servers and restart the configured server.",
  }),
] as const satisfies readonly ConfigurationTargetDefinition[]);
