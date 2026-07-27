export class InvalidUtf8Error extends Error {
  constructor(cause: unknown) {
    super("Input must be valid UTF-8.", { cause });
    this.name = "InvalidUtf8Error";
  }
}

function decode(
  decoder: InstanceType<typeof TextDecoder>,
  chunk?: Uint8Array,
  stream = false,
): string {
  try {
    return decoder.decode(chunk, { stream });
  } catch (cause) {
    throw new InvalidUtf8Error(cause);
  }
}

function endsWithHighSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const codeUnit = value.charCodeAt(value.length - 1);
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

export async function readUtf8(
  input: AsyncIterable<string | Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();
  const decoded: string[] = [];
  let pendingHighSurrogate = "";

  const appendBytes = (chunk?: Uint8Array, stream = false): void => {
    const value = decode(decoder, chunk, stream);
    if (value.length > 0) decoded.push(value);
  };

  const appendString = (chunk: string): void => {
    const value = `${pendingHighSurrogate}${chunk}`;
    if (endsWithHighSurrogate(value)) {
      pendingHighSurrogate = value.slice(-1);
      const complete = value.slice(0, -1);
      if (complete.length > 0) {
        appendBytes(encoder.encode(complete), true);
      }
      return;
    }

    pendingHighSurrogate = "";
    if (value.length > 0) {
      appendBytes(encoder.encode(value), true);
    }
  };

  for await (const chunk of input) {
    if (typeof chunk === "string") {
      appendString(chunk);
      continue;
    }

    if (chunk.byteLength === 0) continue;
    if (pendingHighSurrogate !== "") {
      appendBytes(encoder.encode(pendingHighSurrogate), true);
      pendingHighSurrogate = "";
    }
    appendBytes(chunk, true);
  }

  if (pendingHighSurrogate !== "") {
    appendBytes(encoder.encode(pendingHighSurrogate), true);
  }
  appendBytes();
  return decoded.join("");
}
