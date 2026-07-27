import { describe, expect, it } from "vitest";

import { readUtf8 } from "../src/stdin.js";

describe("the default UTF-8 stdin reader", () => {
  it("preserves a multibyte code point split across chunks", async () => {
    const expected = '{"value":"😀"}';
    const encoded = new TextEncoder().encode(expected);
    const multibyteStart = encoded.indexOf(0xf0);

    async function* chunks(): AsyncIterable<Uint8Array> {
      yield encoded.subarray(0, multibyteStart + 2);
      yield encoded.subarray(multibyteStart + 2);
    }

    await expect(readUtf8(chunks())).resolves.toBe(expected);
  });
});
