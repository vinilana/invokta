import { describe, expect, it } from "vitest";

import { runProbe } from "../src/probe.js";
import { createTestContext } from "./support/test-context.js";

describe("runProbe", () => {
  it("reports that the command is not implemented and writes nothing to stdout", async () => {
    const harness = createTestContext();

    const exitCode = await runProbe([], harness.context);

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      'The "probe" command is not implemented yet.\n',
    ]);
  });
});
