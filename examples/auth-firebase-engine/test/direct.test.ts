import { describe, expect, it, vi } from "vitest";

import { main } from "../src/direct.js";

describe("embedded invocation", () => {
  it("invokes the capability with a principal mapped from verified claims", async () => {
    const written: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(chunk.toString());
        return true;
      });

    try {
      await main();
    } finally {
      write.mockRestore();
    }

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "")).toEqual({
      principalId: "uid-demo-1",
      attributes: {
        email: "ada@example.com",
        emailVerified: true,
        authTime: 1_754_400_000,
        signInProvider: "password",
        customClaims: { role: "support-agent" },
      },
    });
  });
});
