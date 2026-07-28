import { describe, expect, it } from "vitest";

import { createNodeFileSystem } from "../src/node-file-system.js";

describe("Node installer filesystem adapter", () => {
  it("reads bytes through the internal injectable boundary", async () => {
    const fileSystem = createNodeFileSystem();

    const bytes = await fileSystem.readFile(
      new URL("../package.json", import.meta.url),
    );
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly name: string;
    };

    expect(manifest.name).toBe("@ai-engine/installer");
  });
});
