import { pathToFileURL } from "node:url";

import type { AgentHarness } from "./domain/agent-session.js";
import { createDefaultAgentSessionEngine } from "./engine.js";
import { runHookCommand } from "./hooks/hook-adapter.js";
import { hookPrincipal } from "./local-principal.js";

export const AGENT_SESSION_ID_ENV = "AGENT_SESSION_ENGINE_SESSION_ID";
export const MAX_HOOK_INPUT_BYTES = 4_194_304;

const supportedHarnesses: ReadonlySet<string> = new Set([
  "cursor",
  "antigravity",
  "claude-code",
  "codex",
]);

async function readHookInput(): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let decoded = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    bytes += buffer.byteLength;
    if (bytes > MAX_HOOK_INPUT_BYTES) {
      throw new Error("Hook input exceeds 4194304 bytes.");
    }
    decoded += decoder.decode(buffer, { stream: true });
  }
  decoded += decoder.decode();
  return decoded;
}

export async function main(): Promise<number> {
  const [harnessArgument, eventName] = process.argv.slice(2);
  if (
    harnessArgument === undefined ||
    !supportedHarnesses.has(harnessArgument)
  ) {
    process.stderr.write(
      "Usage: hook-cli <cursor|antigravity|claude-code|codex> [event-name]\n",
    );
    return 2;
  }
  const harness = harnessArgument as AgentHarness;
  try {
    return await runHookCommand(harness, {
      rawInput: await readHookInput(),
      ...(process.env[AGENT_SESSION_ID_ENV] === undefined
        ? {}
        : { portableSessionId: process.env[AGENT_SESSION_ID_ENV] }),
      ...(eventName === undefined ? {} : { eventName }),
      observedAt: new Date().toISOString(),
      cwd: process.cwd(),
      engine: createDefaultAgentSessionEngine(),
      principal: hookPrincipal,
      writeStdout: (text) => {
        process.stdout.write(text);
      },
      writeStderr: (text) => {
        process.stderr.write(text);
      },
    });
  } catch {
    process.stderr.write("Agent session hook recording failed.\n");
    return 1;
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = await main();
}
