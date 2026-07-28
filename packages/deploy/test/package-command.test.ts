import { describe, expect, it } from "vitest";

import { runPackage } from "../src/package-command.js";
import { createTestContext } from "./support/test-context.js";

describe("runPackage", () => {
  it("reports that the command is not implemented and writes nothing to stdout", async () => {
    const harness = createTestContext();

    const exitCode = await runPackage([], harness.context);

    expect(exitCode).toBe(2);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr).toEqual([
      'The "package" command is not implemented yet.\n',
    ]);
  });
});
