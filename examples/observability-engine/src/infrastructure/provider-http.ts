import { EngineError } from "@ai-engine/core";

export type ProviderName = "sentry" | "datadog" | "new-relic";

const maximumCauseLength = 512;

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

export async function requestProviderJson(
  provider: ProviderName,
  url: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw providerFailure(
      provider,
      `The ${provider} request could not be completed.`,
      undefined,
      cause,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw providerFailure(
      provider,
      `${provider} rejected the request.`,
      response.status,
      new Error(
        `${provider} responded with status ${String(response.status)}: ${detail.slice(0, maximumCauseLength)}`,
      ),
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw providerFailure(
      provider,
      `${provider} returned an unreadable payload.`,
      undefined,
      cause,
    );
  }
}
