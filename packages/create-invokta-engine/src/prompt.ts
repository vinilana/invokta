import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export const promptInputLimits = Object.freeze({
  maxAnswerBytes: 4_096,
});

export interface BoundedPromptInput {
  /** Returns one answer including LF, or undefined when the answer was aborted. */
  readonly readLine: () => Promise<Uint8Array | undefined>;
}

type InterruptSource = Pick<EventEmitter, "once" | "removeListener">;

function toBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new TypeError("The prompt input produced an unsupported chunk.");
}

function waitForReadable(
  stream: Readable,
  interrupts: InterruptSource,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener("readable", onReadable);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onEnd);
      stream.removeListener("error", onError);
      interrupts.removeListener("SIGINT", onInterrupt);
    };
    const onReadable = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onInterrupt = (): void => {
      cleanup();
      reject(new Error("The interactive prompt was interrupted."));
    };

    stream.once("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
    stream.once("error", onError);
    interrupts.once("SIGINT", onInterrupt);
  });
}

/** Creates a byte-bounded, line-oriented reader without a terminal UI dependency. */
export function createBoundedPromptInput(
  stream: Readable,
  interrupts: InterruptSource = process,
): BoundedPromptInput {
  let reading = false;

  return Object.freeze({
    async readLine(): Promise<Uint8Array | undefined> {
      if (reading) {
        throw new TypeError("Only one interactive prompt may be active.");
      }
      reading = true;
      const buffer = new Uint8Array(promptInputLimits.maxAnswerBytes + 1);
      let length = 0;

      try {
        while (true) {
          const chunk = stream.read(1) as unknown;
          if (chunk !== null) {
            for (const byte of toBytes(chunk)) {
              buffer[length] = byte;
              length += 1;
              if (length > promptInputLimits.maxAnswerBytes || byte === 0x0a) {
                return buffer.slice(0, length);
              }
            }
            continue;
          }

          if (stream.readableEnded || stream.destroyed) {
            if (stream.errored instanceof Error) throw stream.errored;
            return undefined;
          }
          await waitForReadable(stream, interrupts);
        }
      } finally {
        reading = false;
      }
    },
  });
}
