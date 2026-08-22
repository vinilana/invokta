import type { TelemetryReader } from "../application/ports.js";
import type { ServiceTelemetry } from "../domain/incident-context.js";
import {
  asRecord,
  providerFailure,
  providerUrl,
  requestProviderJson,
} from "./provider-http.js";

export interface NewRelicTelemetryReaderOptions {
  readonly userKey: string;
  readonly accountId: number;
  readonly graphqlUrl?: string;
}

const defaultGraphqlUrl = "https://api.newrelic.com/graphql";

function readFiniteNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toTelemetry(value: unknown): ServiceTelemetry | null {
  const row = asRecord(value);
  if (row === null) return null;
  const transactionCount = readFiniteNumber(row, "transactionCount");
  const rawErrorRate = row.errorRate;
  const errorRate =
    rawErrorRate === null ? 0 : readFiniteNumber(row, "errorRate");
  const rawAverageDuration = row.averageDurationMs;
  const averageDurationMs =
    rawAverageDuration === null
      ? null
      : readFiniteNumber(row, "averageDurationMs");
  if (
    transactionCount === null ||
    !Number.isSafeInteger(transactionCount) ||
    transactionCount < 0 ||
    errorRate === null ||
    errorRate < 0 ||
    errorRate > 100 ||
    (averageDurationMs !== null && averageDurationMs < 0)
  ) {
    return null;
  }
  return { transactionCount, errorRate, averageDurationMs };
}

function createNrql(service: string, from: string, to: string): string {
  return [
    "SELECT count(*) AS 'transactionCount',",
    "percentage(count(*), WHERE error IS true) AS 'errorRate',",
    "average(duration) * 1000 AS 'averageDurationMs'",
    "FROM Transaction",
    `WHERE appName = '${service}'`,
    `SINCE ${String(Date.parse(from))} UNTIL ${String(Date.parse(to))}`,
  ].join(" ");
}

export function createNewRelicTelemetryReader(
  options: NewRelicTelemetryReaderOptions,
): TelemetryReader {
  if (options.userKey === "") {
    throw new TypeError("A New Relic user key is required.");
  }
  if (!Number.isSafeInteger(options.accountId) || options.accountId <= 0) {
    throw new TypeError("A positive New Relic account ID is required.");
  }
  const graphqlUrl = providerUrl(
    options.graphqlUrl ?? defaultGraphqlUrl,
    "New Relic graphqlUrl",
  );

  return {
    async summarizeService(request, { signal }) {
      const nrql = createNrql(request.service, request.from, request.to);
      const graphQl = [
        "query {",
        "actor {",
        `account(id: ${String(options.accountId)}) {`,
        `nrql(query: ${JSON.stringify(nrql)}) { results }`,
        "}",
        "}",
        "}",
      ].join(" ");
      const payload = await requestProviderJson(
        "new-relic",
        graphqlUrl,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "api-key": options.userKey,
          },
          body: JSON.stringify({ query: graphQl }),
        },
        signal,
      );
      const response = asRecord(payload);
      if (Array.isArray(response?.errors) && response.errors.length > 0) {
        throw providerFailure(
          "new-relic",
          "New Relic returned an unsuccessful result.",
        );
      }
      const data = response === null ? null : asRecord(response.data);
      const actor = data === null ? null : asRecord(data.actor);
      const account = actor === null ? null : asRecord(actor.account);
      const nrqlResult = account === null ? null : asRecord(account.nrql);
      const results = nrqlResult?.results;
      const telemetry =
        Array.isArray(results) && results.length === 1
          ? toTelemetry(results[0])
          : null;
      if (telemetry === null) {
        throw providerFailure(
          "new-relic",
          "New Relic returned an unexpected payload.",
        );
      }
      return telemetry;
    },
  };
}
