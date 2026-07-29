import type {
  IncidentContextRequest,
  IssueSummary,
  LogSummary,
  ServiceTelemetry,
} from "../domain/incident-context.js";

export interface ProviderCallOptions {
  readonly signal: AbortSignal;
}

export interface IssueTracker {
  searchServiceIssues(
    request: IncidentContextRequest,
    options: ProviderCallOptions,
  ): Promise<ReadonlyArray<IssueSummary>>;
}

export interface LogStore {
  searchServiceLogs(
    request: IncidentContextRequest,
    options: ProviderCallOptions,
  ): Promise<ReadonlyArray<LogSummary>>;
}

export interface TelemetryReader {
  summarizeService(
    request: IncidentContextRequest,
    options: ProviderCallOptions,
  ): Promise<ServiceTelemetry>;
}

export interface ObservabilityDependencies {
  readonly issues: IssueTracker;
  readonly logs: LogStore;
  readonly telemetry: TelemetryReader;
}
