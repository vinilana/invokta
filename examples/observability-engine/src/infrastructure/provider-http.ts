import { EngineError } from "@invokta/core";

export type ProviderName = "sentry" | "datadog" | "new-relic";

const maximumProviderResponseBytes = 64 * 1024 * 1024;

export function isCredentialFreeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function providerUrl(value: string, optionName: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${optionName} must be a credential-free HTTP(S) URL.`);
  }
  if (!isCredentialFreeHttpUrl(value)) {
    throw new TypeError(`${optionName} must be a credential-free HTTP(S) URL.`);
  }
  return url;
}

export function providerFailure(
  provider: ProviderName,
  message: string,
  status?: number,
  cause?: unknown,
): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message,
    publicDetails: {
      provider,
      ...(status === undefined ? {} : { status }),
    },
    ...(cause === undefined ? {} : { cause }),
  });
}

export function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function readRequiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function readOptionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function responseLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = responseLength(response);
  if (
    declaredLength !== null &&
    declaredLength > maximumProviderResponseBytes
  ) {
    throw new RangeError(
      "Provider response exceeds the configured byte limit.",
    );
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumProviderResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError(
          "Provider response exceeds the configured byte limit.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function requestProviderJson(
  provider: ProviderName,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, { ...init, signal });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw providerFailure(
      provider,
      `The ${provider} request could not be completed.`,
      undefined,
      new Error(`${provider} transport request failed.`),
    );
  }

  if (signal.aborted) throw signal.reason;

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw providerFailure(
      provider,
      `${provider} rejected the request.`,
      response.status,
      new Error(
        `${provider} responded with status ${String(response.status)}.`,
      ),
    );
  }

  let text: string;
  try {
    text = await readBoundedText(response);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw providerFailure(
      provider,
      `${provider} returned an unreadable payload.`,
      undefined,
      new Error(`${provider} response could not be read safely.`),
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw providerFailure(
      provider,
      `${provider} returned an unreadable payload.`,
      undefined,
      new Error(`${provider} response was not valid JSON.`),
    );
  }
}
