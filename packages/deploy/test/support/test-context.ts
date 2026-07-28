import { vi } from "vitest";

import type { DeployContext } from "../../src/io.js";

export interface TestContextOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface TestContext {
  readonly context: DeployContext;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly writeStdout: ReturnType<typeof vi.fn>;
  readonly writeStderr: ReturnType<typeof vi.fn>;
}

/**
 * Builds a command context whose sinks record instead of writing, so every
 * test observes command output without touching the process streams.
 */
export function createTestContext(
  options: TestContextOptions = {},
): TestContext {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeStdout = vi.fn((text: string) => {
    stdout.push(text);
  });
  const writeStderr = vi.fn((text: string) => {
    stderr.push(text);
  });
  return {
    context: {
      cwd: options.cwd ?? "/workspace/engine",
      env: options.env ?? {},
      io: { writeStdout, writeStderr },
    },
    stdout,
    stderr,
    writeStdout,
    writeStderr,
  };
}
