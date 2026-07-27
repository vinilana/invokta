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

  it("preserves a surrogate pair split across string chunks", async () => {
    async function* chunks(): AsyncIterable<string> {
      yield '{"value":"\ud83d';
      yield '\ude00"}';
    }

    await expect(readUtf8(chunks())).resolves.toBe('{"value":"😀"}');
  });

  it("rejects malformed UTF-8 bytes", async () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield Uint8Array.of(0x7b, 0x22, 0x76, 0x22, 0x3a, 0x22);
      yield Uint8Array.of(0xc3);
      yield Uint8Array.of(0x28, 0x22, 0x7d);
    }

    await expect(readUtf8(chunks())).rejects.toThrow(
      "Input must be valid UTF-8.",
    );
  });
});
