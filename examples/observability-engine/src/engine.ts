import { createEngine } from "@invokta/core";

import type { ObservabilityDependencies } from "./application/ports.js";
import { createCollectIncidentContext } from "./capabilities/collect-incident-context.js";
import { datadogConnector } from "./infrastructure/datadog-log-store.js";
import { newRelicConnector } from "./infrastructure/new-relic-telemetry-reader.js";
import { sentryConnector } from "./infrastructure/sentry-issue-tracker.js";

export function createObservabilityEngine(
  dependencies: ObservabilityDependencies,
) {
  return createEngine({
    name: "observability-engine",
    version: "0.1.0",
    capabilities: {
      "observability.collect-incident-context":
        createCollectIncidentContext(dependencies),
    },
  });
}

export interface ObservabilityEnvironment {
  readonly SENTRY_AUTH_TOKEN?: string | undefined;
  readonly SENTRY_ORG?: string | undefined;
  readonly SENTRY_BASE_URL?: string | undefined;
  readonly DD_API_KEY?: string | undefined;
  readonly DD_APP_KEY?: string | undefined;
  readonly DD_BASE_URL?: string | undefined;
  readonly NEW_RELIC_USER_KEY?: string | undefined;
  readonly NEW_RELIC_ACCOUNT_ID?: string | undefined;
  readonly NEW_RELIC_GRAPHQL_URL?: string | undefined;
}

function requireEnvironment(
  environment: ObservabilityEnvironment,
  key: keyof ObservabilityEnvironment,
): string {
  const value = environment[key];
  if (value === undefined || value === "") {
    throw new Error(`${key} is required.`);
  }
  return value;
}

export function createProviderBackedObservabilityEngine(
  environment: ObservabilityEnvironment = process.env,
) {
  const sentryAuthToken = requireEnvironment(environment, "SENTRY_AUTH_TOKEN");
  const sentryOrganization = requireEnvironment(environment, "SENTRY_ORG");
  const datadogApiKey = requireEnvironment(environment, "DD_API_KEY");
  const datadogApplicationKey = requireEnvironment(environment, "DD_APP_KEY");
  const newRelicUserKey = requireEnvironment(environment, "NEW_RELIC_USER_KEY");
  const accountIdText = requireEnvironment(environment, "NEW_RELIC_ACCOUNT_ID");
  const newRelicAccountId = Number(accountIdText);
  if (!Number.isSafeInteger(newRelicAccountId) || newRelicAccountId <= 0) {
    throw new Error("NEW_RELIC_ACCOUNT_ID must be a positive integer.");
  }

  const transport = { fetch: globalThis.fetch };
  const sentry = sentryConnector.create(
    {
      authToken: sentryAuthToken,
      organization: sentryOrganization,
      ...(environment.SENTRY_BASE_URL === undefined ||
      environment.SENTRY_BASE_URL === ""
        ? {}
        : { baseUrl: environment.SENTRY_BASE_URL }),
    },
    transport,
  );
  const datadog = datadogConnector.create(
    {
      apiKey: datadogApiKey,
      applicationKey: datadogApplicationKey,
      ...(environment.DD_BASE_URL === undefined ||
      environment.DD_BASE_URL === ""
        ? {}
        : { baseUrl: environment.DD_BASE_URL }),
    },
    transport,
  );
  const newRelic = newRelicConnector.create(
    {
      userKey: newRelicUserKey,
      accountId: newRelicAccountId,
      ...(environment.NEW_RELIC_GRAPHQL_URL === undefined ||
      environment.NEW_RELIC_GRAPHQL_URL === ""
        ? {}
        : { graphqlUrl: environment.NEW_RELIC_GRAPHQL_URL }),
    },
    transport,
  );

  return createObservabilityEngine({
    issues: sentry.ports.issues,
    logs: datadog.ports.logs,
    telemetry: newRelic.ports.telemetry,
  });
}
