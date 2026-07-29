import type { IssueTracker } from "../application/ports.js";
import type { IssueSummary } from "../domain/incident-context.js";
import {
  asRecord,
  providerFailure,
  readOptionalString,
  readRequiredString,
  requestProviderJson,
} from "./provider-http.js";

export interface SentryIssueTrackerOptions {
  readonly authToken: string;
  readonly organization: string;
  readonly baseUrl?: string;
}

const defaultBaseUrl = "https://sentry.io";

function toIssue(value: unknown): IssueSummary | null {
  const issue = asRecord(value);
  if (issue === null) return null;
  const project = asRecord(issue.project);
  const id = readRequiredString(issue, "id");
  const title = readRequiredString(issue, "title");
  const status = readRequiredString(issue, "status");
  const projectSlug =
    project === null ? null : readRequiredString(project, "slug");
  const lastSeen = readRequiredString(issue, "lastSeen");
  const count = readRequiredString(issue, "count");
  if (
    id === null ||
    title === null ||
    status === null ||
    projectSlug === null ||
    lastSeen === null ||
    count === null ||
    !/^(?:0|[1-9][0-9]*)$/u.test(count)
  ) {
    return null;
  }
  const eventCount = Number(count);
  if (!Number.isSafeInteger(eventCount)) return null;
  return {
    id,
    title,
    status,
    project: projectSlug,
    lastSeen,
    eventCount,
    url: readOptionalString(issue, "permalink"),
  };
}

export function createSentryIssueTracker(
  options: SentryIssueTrackerOptions,
): IssueTracker {
  if (options.authToken === "") {
    throw new TypeError("A Sentry auth token is required.");
  }
  if (options.organization === "") {
    throw new TypeError("A Sentry organization is required.");
  }
  const baseUrl = new URL(options.baseUrl ?? defaultBaseUrl);

  return {
    async searchServiceIssues(request, { signal }) {
      const url = new URL(
        `/api/0/organizations/${encodeURIComponent(options.organization)}/issues/`,
        baseUrl,
      );
      url.searchParams.set("project", request.service);
      url.searchParams.set("query", "is:unresolved");
      url.searchParams.set("start", request.from);
      url.searchParams.set("end", request.to);
      url.searchParams.set("sort", "date");
      url.searchParams.set("limit", String(request.limit));
      const payload = await requestProviderJson(
        "sentry",
        url,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${options.authToken}`,
          },
        },
        signal,
      );
      if (!Array.isArray(payload)) {
        throw providerFailure(
          "sentry",
          "Sentry returned an unexpected payload.",
        );
      }
      const issues = payload.map(toIssue);
      if (issues.some((issue) => issue === null)) {
        throw providerFailure("sentry", "Sentry returned an unexpected issue.");
      }
      return issues as IssueSummary[];
    },
  };
}
