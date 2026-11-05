import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { sha256Hex } from "../src/sha256.js";

function nodeSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

it("matches the FIPS 180-4 test vectors", () => {
  expect(sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
  ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

it("matches Node.js for every padding boundary and UTF-8 input", () => {
  const inputs = [
    ...Array.from({ length: 130 }, (_, length) => "a".repeat(length)),
    "knowledge/ação",
    "support.classify-ticket".repeat(20),
    "😀".repeat(40),
    "lone \ud800 surrogate",
    "x".repeat(100_000),
  ];

  for (const input of inputs) {
    expect(sha256Hex(input), JSON.stringify(input.slice(0, 32))).toBe(
      nodeSha256(input),
    );
  }
});
