export interface IncidentContextRequest {
  readonly service: string;
  readonly from: string;
  readonly to: string;
  readonly limit: number;
}

export interface IssueSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly project: string;
  readonly lastSeen: string;
  readonly eventCount: number;
  readonly url: string | null;
}

export interface LogSummary {
  readonly id: string;
  readonly timestamp: string;
  readonly service: string;
  readonly severity: string | null;
  readonly message: string;
}

export interface ServiceTelemetry {
  readonly transactionCount: number;
  readonly errorRate: number;
  readonly averageDurationMs: number | null;
}
