export async function readUtf8(
  input: AsyncIterable<string | Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
