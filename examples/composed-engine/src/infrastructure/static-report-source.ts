import type { ReportSource } from "../application/ports.js";
import type { OperationsReport } from "../domain/report.js";

export function createStaticReportSource(
  reports: ReadonlyArray<OperationsReport>,
): ReportSource {
  const reportsByDay = new Map(reports.map((report) => [report.day, report]));
  return {
    async summarize(day, { signal }) {
      signal.throwIfAborted();
      return (
        reportsByDay.get(day) ?? {
          day,
          openTickets: 0,
          resolvedTickets: 0,
          headline: "No operational activity was recorded.",
        }
      );
    },
  };
}
