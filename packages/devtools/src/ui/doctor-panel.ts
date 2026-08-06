import { api } from "./api.js";
import { clear, el, pretty } from "./dom.js";

export function renderDoctorPanel(container: HTMLElement): void {
  void api.doctor().then((report) => {
    clear(container);
    container.append(
      el("h2", {}, ["Doctor"]),
      el("p", {}, [
        `${report.engineName} ${report.engineVersion} — ${String(
          report.capabilityCount ?? 0,
        )} capabilities`,
      ]),
      el("h3", {}, [
        report.findings.length === 0
          ? "No findings"
          : `Findings (${String(report.findings.length)})`,
      ]),
      ...report.findings.map((finding) =>
        el("pre", { class: "raw error" }, [pretty(finding)]),
      ),
      el("h3", {}, [`Notes (${String(report.notes.length)})`]),
      ...report.notes.map((note) =>
        el("pre", { class: "raw" }, [pretty(note)]),
      ),
    );
  });
}
