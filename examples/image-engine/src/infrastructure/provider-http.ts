import { EngineError } from "@ai-engine/core";

const maximumProviderResponseBytes = 64 * 1024 * 1024;
const maximumCauseCharacters = 512;

export interface ProviderHttpRequest {
  readonly provider: string;
  readonly providerLabel: string;
  readonly url: URL;
  readonly init: RequestInit;
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
  readonly requestFailureMessage: string;
  readonly rejectionMessage: string;
}

export function providerFailure(
  message: string,
  publicDetails: Readonly<Record<string, unknown>>,
  cause?: unknown,
): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message,
    publicDetails,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function providerEndpoint(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  if (
    (base.protocol !== "https:" && base.protocol !== "http:") ||
    base.username !== "" ||
    base.password !== ""
  ) {
    throw new TypeError(
      "Provider base URL must be a credential-free HTTP(S) URL.",
    );
  }
  const normalizedPath = `${base.pathname.replace(/\/+$/u, "")}/`;
  return new URL(path.replace(/^\/+/, ""), `${base.origin}${normalizedPath}`);
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
        await reader.cancel();
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
  request: ProviderHttpRequest,
): Promise<unknown> {
  let response: Response;
  try {
    response = await request.fetch(request.url, {
      ...request.init,
      signal: request.signal,
    });
  } catch (cause) {
    if (request.signal.aborted) throw cause;
    throw providerFailure(
      request.requestFailureMessage,
      { provider: request.provider },
      cause,
    );
  }

  if (!response.ok) {
    const detail = await readBoundedText(response).catch(() => "");
    throw providerFailure(
      request.rejectionMessage,
      { provider: request.provider, status: response.status },
      new Error(
        `${request.providerLabel} responded with status ${String(response.status)}: ${detail.slice(0, maximumCauseCharacters)}`,
      ),
    );
  }

  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (cause) {
    throw providerFailure(
      `${request.providerLabel} returned an unreadable response.`,
      { provider: request.provider },
      cause,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw providerFailure(
      `${request.providerLabel} returned an unreadable response.`,
      { provider: request.provider },
      cause,
    );
  }
}

export function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
