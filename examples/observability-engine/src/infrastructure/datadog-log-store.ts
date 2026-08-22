import type { LogStore } from "../application/ports.js";
import type { LogSummary } from "../domain/incident-context.js";
import {
  asRecord,
  providerFailure,
  providerUrl,
  readOptionalString,
  readRequiredString,
  requestProviderJson,
} from "./provider-http.js";

export interface DatadogLogStoreOptions {
  readonly apiKey: string;
  readonly applicationKey: string;
  readonly baseUrl?: string;
}

const defaultBaseUrl = "https://api.datadoghq.com";

function toLog(value: unknown, fallbackService: string): LogSummary | null {
  const log = asRecord(value);
  const attributes = log === null ? null : asRecord(log.attributes);
  if (log === null || attributes === null) return null;
  const id = readRequiredString(log, "id");
  const timestamp = readRequiredString(attributes, "timestamp");
  const message = readRequiredString(attributes, "message");
  if (id === null || timestamp === null || message === null) return null;
  return {
    id,
    timestamp,
    service: readOptionalString(attributes, "service") ?? fallbackService,
    severity: readOptionalString(attributes, "status"),
    message,
  };
}

export function createDatadogLogStore(
  options: DatadogLogStoreOptions,
): LogStore {
  if (options.apiKey === "") {
    throw new TypeError("A Datadog API key is required.");
  }
  if (options.applicationKey === "") {
    throw new TypeError("A Datadog application key is required.");
  }
  const baseUrl = providerUrl(
    options.baseUrl ?? defaultBaseUrl,
    "Datadog baseUrl",
  );

  return {
    async searchServiceLogs(request, { signal }) {
      const payload = await requestProviderJson(
        "datadog",
        new URL("/api/v2/logs/events/search", baseUrl),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "dd-api-key": options.apiKey,
            "dd-application-key": options.applicationKey,
          },
          body: JSON.stringify({
            filter: {
              query: `service:${request.service}`,
              from: request.from,
              to: request.to,
            },
            page: { limit: request.limit },
            sort: "-timestamp",
          }),
        },
        signal,
      );
      const response = asRecord(payload);
      const data = response?.data;
      if (!Array.isArray(data)) {
        throw providerFailure(
          "datadog",
          "Datadog returned an unexpected payload.",
        );
      }
      const logs = data.map((item) => toLog(item, request.service));
      if (logs.some((log) => log === null)) {
        throw providerFailure("datadog", "Datadog returned an unexpected log.");
      }
      return logs as LogSummary[];
    },
  };
}
