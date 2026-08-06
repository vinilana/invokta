import { api } from "./api.js";
import { clear, el, pretty } from "./dom.js";

export function renderDoctorPanel(container: HTMLElement): () => void {
  let active = true;
  clear(container);
  container.append(
    el("h2", {}, ["Doctor"]),
    el("p", { class: "hint", role: "status" }, ["Running checks…"]),
  );

  void api
    .doctor()
    .then((report) => {
      if (!active) return;
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
    })
    .catch(() => {
      if (!active) return;
      clear(container);
      container.append(
        el("h2", {}, ["Doctor"]),
        el("p", { class: "feedback", role: "alert" }, [
          "Doctor checks could not be loaded. Check that the dev server is still running.",
        ]),
      );
    });

  return () => {
    active = false;
  };
}
