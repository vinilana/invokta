import { el } from "./dom.js";

const restoreDelayMs = 1_600;

interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

function clipboardWriter(): ClipboardWriter | undefined {
  return (
    globalThis as {
      navigator?: { clipboard?: ClipboardWriter };
    }
  ).navigator?.clipboard;
}

/**
 * A compact copy control for one dense surface. Lifting a payload out of the
 * workbench is the most repeated gesture in this interface, so every code
 * window, schema, and traced body carries its own button that reports the
 * outcome in place instead of relying on manual selection.
 */
export function createCopyButton(
  label: string,
  read: () => string,
  className = "copy-button",
): HTMLButtonElement {
  const button = el(
    "button",
    {
      type: "button",
      class: className,
      "data-state": "idle",
      "aria-label": `Copy ${label}`,
      "aria-live": "polite",
      title: `Copy ${label}`,
    },
    ["Copy"],
  );

  let restore: ReturnType<typeof setTimeout> | undefined;
  const report = (text: string, failed: boolean): void => {
    button.textContent = text;
    button.setAttribute("data-state", failed ? "failed" : "copied");
    if (restore !== undefined) clearTimeout(restore);
    restore = setTimeout(() => {
      restore = undefined;
      button.textContent = "Copy";
      button.setAttribute("data-state", "idle");
    }, restoreDelayMs);
  };

  button.addEventListener("click", () => {
    const text = read();
    if (text === "") {
      report("Nothing yet", true);
      return;
    }
    const clipboard = clipboardWriter();
    if (clipboard === undefined) {
      report("Unavailable", true);
      return;
    }
    void clipboard.writeText(text).then(
      () => {
        report("Copied", false);
      },
      () => {
        report("Failed", true);
      },
    );
  });

  return button;
}

/** Formats an elapsed measurement for a status line at readable precision. */
export function formatDuration(durationMs: number): string {
  if (durationMs >= 1_000) return `${(durationMs / 1_000).toFixed(2)} s`;
  return `${durationMs.toFixed(1)} ms`;
}
