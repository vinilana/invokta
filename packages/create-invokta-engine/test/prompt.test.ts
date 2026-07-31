import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createBoundedPromptInput } from "../src/prompt.js";

const decoder = new TextDecoder();

describe("createBoundedPromptInput", () => {
  it("reads one LF-terminated answer at a time and preserves buffered input", async () => {
    const stream = new PassThrough();
    const interrupts = new EventEmitter();
    const input = createBoundedPromptInput(stream, interrupts);
    stream.end("first\nsecond\n");

    expect(decoder.decode(await input.readLine())).toBe("first\n");
    expect(decoder.decode(await input.readLine())).toBe("second\n");
    await expect(input.readLine()).resolves.toBeUndefined();
  });

  it("preserves a UTF-8 code point split across stream chunks", async () => {
    const stream = new PassThrough();
    const input = createBoundedPromptInput(stream, new EventEmitter());
    stream.write(Uint8Array.from([0xe2, 0x82]));
    stream.end(Uint8Array.from([0xac, 0x0a]));

    expect(await input.readLine()).toEqual(
      Uint8Array.from([0xe2, 0x82, 0xac, 0x0a]),
    );
  });

  it("retains only the boundary plus the first overflowing byte", async () => {
    const stream = new PassThrough();
    const input = createBoundedPromptInput(stream, new EventEmitter());
    stream.end(`${"a".repeat(4_096)}\nignored`);

    const answer = await input.readLine();

    expect(answer).toHaveLength(4_097);
  });

  it("treats EOF before a line terminator as an aborted answer", async () => {
    const stream = new PassThrough();
    const input = createBoundedPromptInput(stream, new EventEmitter());
    stream.end("partial");

    await expect(input.readLine()).resolves.toBeUndefined();
  });

  it("rejects a stream failure and a terminal interruption", async () => {
    const failedStream = new PassThrough();
    const failed = createBoundedPromptInput(failedStream, new EventEmitter());
    const failedRead = failed.readLine();
    failedStream.destroy(new Error("fixture stream failure"));
    await expect(failedRead).rejects.toThrow("fixture stream failure");

    const interruptedStream = new PassThrough();
    const interrupts = new EventEmitter();
    const interrupted = createBoundedPromptInput(interruptedStream, interrupts);
    const interruptedRead = interrupted.readLine();
    interrupts.emit("SIGINT");
    await expect(interruptedRead).rejects.toThrow();
  });
});
