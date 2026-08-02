/**
 * Best-effort browser launch.
 *
 * This is the only process execution the console performs, it is never
 * required, and its failure cannot affect the session: the URL is printed
 * first, so the operator can always open it themselves. WSL is detected
 * explicitly because `xdg-open` there has no display to reach.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export interface OpenBrowserOptions {
  readonly platform?: NodeJS.Platform;
  readonly readProcVersion?: () => string;
  readonly launch?: (command: string, argument: string) => void;
}

function underWindowsSubsystemForLinux(read: () => string): boolean {
  try {
    return read().toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

export function browserCommandFor(
  platform: NodeJS.Platform,
  isWsl: boolean,
): string {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "cmd";
  return isWsl ? "explorer.exe" : "xdg-open";
}

export function openBrowser(
  url: string,
  options: OpenBrowserOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const readProcVersion =
    options.readProcVersion ?? (() => readFileSync("/proc/version", "utf8"));
  const isWsl =
    platform === "linux" && underWindowsSubsystemForLinux(readProcVersion);
  const command = browserCommandFor(platform, isWsl);
  const launch =
    options.launch ??
    ((executable: string, argument: string) => {
      const child = spawn(
        executable,
        // `cmd /c start` needs an empty title argument before the URL.
        executable === "cmd" ? ["/c", "start", "", argument] : [argument],
        { detached: true, stdio: "ignore" },
      );
      child.on("error", () => undefined);
      child.unref();
    });
  try {
    launch(command, url);
  } catch {
    // Printing the URL is always the reliable path.
  }
}
