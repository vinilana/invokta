import { describe, expect, it } from "vitest";

import { runInit } from "../src/init.js";
import { createTestContext } from "./support/test-context.js";

describe("runInit", () => {
  it("reports that the command is not implemented and writes nothing to stdout", async () => {
    const harness = createTestContext();

    const exitCode = await runInit([], harness.context);

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      'The "init" command is not implemented yet.\n',
    ]);
  });
});
